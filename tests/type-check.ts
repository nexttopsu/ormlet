/**
 * 编译期类型检查（由 `npm run typecheck` 执行，此文件不会被真正运行）。
 * 验证字段名和值类型的错误用法在编译期即可被 TypeScript 发现。
 */
import { Database } from '../src/index.js';
import type { Model, ModelData, ModelRow } from '../src/index.js';

type UserFields = {
  name: 'TEXT';
  age: 'INTEGER';
  email: 'TEXT';
  score: 'REAL';
  avatar: 'BLOB';
};

const db = new Database(':memory:');

const User = db.model('User', {
  tableName: 'users',
  fields: {
    name: 'TEXT',
    age: 'INTEGER',
    email: 'TEXT',
    score: 'REAL',
    avatar: 'BLOB',
  },
});

// ---- 正确用法：字段名与值类型均能自动推导 ----

const modelTyped: Model<UserFields> = User;

const created: ModelRow<UserFields> = modelTyped.create({
  name: '张三',
  age: 25,
  email: 'z@example.com',
  score: 1.5,
  avatar: new Uint8Array([1, 2, 3]),
});

const id: number = created.id;
const name: string | null = created.name;
const age: number | null = created.age;
const score: number | null = created.score;
const avatar: Uint8Array | null = created.avatar;
const createdAt: string | null = created.createdAt;
const updatedAt: string | null = created.updatedAt;

const found: ModelRow<UserFields> | undefined = modelTyped.findById(1);
const list: ModelRow<UserFields>[] = modelTyped.findMany({ name: '张三', age: 25 });
const total: number = modelTyped.count({ age: 25 });
const updated: ModelRow<UserFields> | undefined = modelTyped.update(1, { age: 26, email: null });
const removed: ModelRow<UserFields> | undefined = modelTyped.delete(1);
const partialData: ModelData<UserFields> = { age: 26 };

// 单行读取与存在性判断
const one: ModelRow<UserFields> | undefined = modelTyped.findOne({ age: 25 });
const latest: ModelRow<UserFields> | undefined = modelTyped.findOne(undefined, { order: 'ASC' });
const present: boolean = modelTyped.exists({ name: '张三' });
const many: Array<ModelRow<UserFields> | undefined> = modelTyped.findByIds([1, 2, 3]);

// 托管列可以出现在查询条件 / 排序 / 投影里
const byId: ModelRow<UserFields>[] = modelTyped.findMany({ id: { in: [1, 2] } });
const byCreated: number = modelTyped.count({ createdAt: { gte: '2026-01-01T00:00:00.000Z' } });
const byUpdated: ModelRow<UserFields>[] = modelTyped.findMany(undefined, { orderBy: 'createdAt' });
const idOnly = modelTyped.findMany({ id: 1 }, { select: ['id'] });
const pickedId: number = idOnly[0]!.id;

// 条件类型不匹配时编译期即报错
// @ts-expect-error id 只接受数字
modelTyped.findMany({ id: 'one' });
// @ts-expect-error 时间戳只接受字符串
modelTyped.findMany({ createdAt: 0 });
// @ts-expect-error findOne 不接受 limit（语义上恒为 1）
modelTyped.findOne({}, { limit: 2 });
// @ts-expect-error deleteMany 必须有条件（清空请用 clear）
modelTyped.deleteMany();

void [
  id,
  name,
  age,
  score,
  avatar,
  createdAt,
  updatedAt,
  found,
  list,
  total,
  updated,
  removed,
  partialData,
  one,
  latest,
  present,
  many,
  byId,
  byCreated,
  byUpdated,
  pickedId,
];

// ---- 错误用法：以下每行都必须产生编译错误 ----

// @ts-expect-error 未知字段
modelTyped.create({ nickname: 'value' });
// @ts-expect-error TEXT 字段传数字
modelTyped.create({ name: 123 });
// @ts-expect-error INTEGER 字段传字符串
modelTyped.create({ age: '25' });
// @ts-expect-error REAL 字段传字符串
modelTyped.create({ score: '1.5' });
// @ts-expect-error BLOB 字段传字符串
modelTyped.create({ avatar: 'binary' });
// @ts-expect-error 更新时传未知字段
modelTyped.update(1, { nickname: 'x' });
// @ts-expect-error 更新时传错误值类型
modelTyped.update(1, { age: '二十五岁' });
// @ts-expect-error 不允许通过 update 修改主键 id
modelTyped.update(1, { id: 2 });
// @ts-expect-error 查询条件传未知字段
modelTyped.findMany({ nickname: 'x' });
// @ts-expect-error 查询条件传错误值类型
modelTyped.findMany({ age: '25' });
// @ts-expect-error 计数条件传错误值类型
modelTyped.count({ name: 123 });
// @ts-expect-error createdAt 由库自动维护，不可传入
modelTyped.create({ createdAt: '2020-01-01T00:00:00.000Z' });
// @ts-expect-error updatedAt 由库自动维护，不可传入
modelTyped.update(1, { updatedAt: '2020-01-01T00:00:00.000Z' });

// ---- findMany 排序与分页 ----

const paged: ModelRow<UserFields>[] = modelTyped.findMany(undefined, {
  orderBy: 'age',
  order: 'ASC',
  limit: 10,
  offset: 20,
});
void paged;

// @ts-expect-error orderBy 未知字段
modelTyped.findMany(undefined, { orderBy: 'nickname' });
// orderBy 允许托管列（上面已有正向断言），这里确认未知字段仍被拒绝
// @ts-expect-error order 只接受 ASC / DESC
modelTyped.findMany(undefined, { order: 'asc' });
// @ts-expect-error 未知选项键
modelTyped.findMany(undefined, { limt: 5 });

// 主键 id 不在模型声明里，但允许作为 orderBy（最常见的分页排序）
const byPk: ModelRow<UserFields>[] = modelTyped.findMany(undefined, { orderBy: 'id', order: 'ASC' });
void byPk;

// ---- search 关键字搜索 ----

const searched: ModelRow<UserFields>[] = modelTyped.search('张', {
  fields: ['name', 'email'],
  orderBy: 'name',
  order: 'ASC',
  limit: 10,
});
void searched;

const keywordTotal: number = modelTyped.count(undefined, { keyword: '张', fields: ['name'] });
void keywordTotal;

// @ts-expect-error search 的 fields 不允许未知字段
modelTyped.search('x', { fields: ['nickname'] });
// @ts-expect-error search 的 fields 只允许 TEXT 字段
modelTyped.search('x', { fields: ['age'] });
// @ts-expect-error count 的 fields 只允许 TEXT 字段
modelTyped.count(undefined, { keyword: 'x', fields: ['age'] });

// ---- 查询条件操作符 ----

const ranged: ModelRow<UserFields>[] = modelTyped.findMany({
  age: { gte: 18, lt: 60 },
  name: { in: ['张三', '李四'] },
  score: { between: [0, 100] },
  email: { isNull: false },
});
const neCount: number = modelTyped.count({ age: { ne: 0 } });
void [ranged, neCount];

// @ts-expect-error 未知操作符
modelTyped.findMany({ age: { like: 1 } });
// @ts-expect-error INTEGER 字段的范围值必须是数字
modelTyped.findMany({ age: { gte: '18' } });
// @ts-expect-error in 必须是数组
modelTyped.findMany({ age: { in: 1 } });
// @ts-expect-error in 的元素类型必须与字段一致
modelTyped.findMany({ age: { in: ['1'] } });
// @ts-expect-error between 必须是二元组
modelTyped.findMany({ age: { between: [1] } });
// @ts-expect-error isNull 只接受布尔值
modelTyped.findMany({ email: { isNull: 'yes' } });
// @ts-expect-error 条件字段必须是模型声明的字段或托管列
modelTyped.findMany({ nickname: { gte: 1 } });

// ---- 事务与批量写入 ----

const inTx: number = db.transaction(() => 1);
const txNested: number[] = db.transaction(() =>
  modelTyped.createMany([
    { name: 'a', age: 1 },
    { name: 'b', age: 2 },
  ]),
);
void [inTx, txNested];

// @ts-expect-error 批量行中的未知字段
modelTyped.createMany([{ nickname: 'x' }]);
// @ts-expect-error 批量行中的错误值类型
modelTyped.createMany([{ age: '25' }]);

const upserted: ModelRow<UserFields> = modelTyped.upsert({ name: 'a' }, { on: ['name'] });
// @ts-expect-error upsert 的 on 必须是已声明字段
modelTyped.upsert({ name: 'a' }, { on: ['nickname'] });
void upserted;

const mutated = modelTyped.updateMany({ age: { gt: 0 } }, { score: 1 });
const removedMany = modelTyped.deleteMany({ age: { isNull: true } });
const changed: number = mutated.changes + removedMany.changes;
void changed;

// ---- select 字段投影 ----

const projected = modelTyped.findMany(undefined, { select: ['id', 'name'] });
// 投影后的行只剩请求的列，可以直接使用
const projectedId: number = projected[0]!.id;
const projectedName: string | null = projected[0]!.name;
// @ts-expect-error 未请求的列不在返回类型里
projected[0]!.age;
void projectedId;
void projectedName;

// 托管列同样可以投影
const withTimestamps = modelTyped.findById(1, { select: ['id', 'createdAt'] });
const projectedCreatedAt: string | null = withTimestamps?.createdAt ?? null;
void projectedCreatedAt;

// 不传 select 时仍返回完整行
const fullRows: ModelRow<UserFields>[] = modelTyped.findMany();
void fullRows;

// @ts-expect-error select 中的未知字段
modelTyped.findMany(undefined, { select: ['nickname'] });
// @ts-expect-error select 只接受列名，不接受任意字符串
modelTyped.search('x', { select: ['name; DROP TABLE users'] });
