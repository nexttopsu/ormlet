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
const updated: boolean = modelTyped.update(1, { age: 26, email: null });
const removed: boolean = modelTyped.delete(1);
const partialData: ModelData<UserFields> = { age: 26 };

void [id, name, age, score, avatar, createdAt, updatedAt, found, list, total, updated, removed, partialData];

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
// @ts-expect-error orderBy 不允许保留字段
modelTyped.findMany(undefined, { orderBy: 'createdAt' });
// @ts-expect-error order 只接受 ASC / DESC
modelTyped.findMany(undefined, { order: 'asc' });
// @ts-expect-error 未知选项键
modelTyped.findMany(undefined, { limt: 5 });

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
