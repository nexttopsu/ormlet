/**
 * ormlet 完整示例 —— 依次演示库的全部公开能力，输出即「可执行的 API 速查表」。
 *
 * 运行：npm run dev
 *
 * 目录：
 *   1  打开数据库            2  定义模型（自动建表）
 *   3  新增                  4  单行读取
 *   5  条件查询（全部操作符） 6  排序 / 分页 / 字段投影
 *   7  关键字搜索与统计       8  游标分页
 *   9  更新与删除           10  批量写入 / upsert
 *  11  批量更新与删除        12  事务
 *  13  字段同步与删除        14  索引与逃生舱（裸 SQL）
 *  15  锁与并发              16  错误类型
 *  17  模型实例              18  关闭数据库
 *
 * 示例使用临时目录里的文件库（这样 WAL、备份、多连接锁竞争才真实可演示），
 * 结束时连同 `-wal` / `-shm` 一起删除，不会在仓库里留下任何文件。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import {
  CheckConstraintError,
  Database,
  DatabaseClosedError,
  ForeignKeyConstraintError,
  InvalidModelError,
  LockTimeoutError,
  NotNullConstraintError,
  SqlModelError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
  isLockConflict,
} from './src/index.js';
import type { Cursor, Page } from './src/index.js';

/* ────────────────────────── 输出辅助 ────────────────────────── */

function section(title: string): void {
  const tail = '─'.repeat(Math.max(4, 74 - [...title].length * 2));
  console.log(`\n──── ${title} ${tail}`);
}

function log(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : inspect(value, { depth: 4, compact: true, breakLength: 96 });
  console.log(`  ${label} → ${text}`);
}

/** 打印调用结果；抛出异常时打印错误类型与消息（本库的错误信息不含 schema 细节）。 */
function attempt<T>(label: string, fn: () => T): T | undefined {
  try {
    const value = fn();
    log(label, value);
    return value;
  } catch (error) {
    log(label, `抛出 ${error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)}`);
    return undefined;
  }
}

/** 断言式示例：确认某个调用抛出了预期类型的错误。 */
function expectError(label: string, Expected: new (...args: never[]) => Error, fn: () => unknown): void {
  try {
    fn();
    log(label, '没有抛错（不符合预期）');
  } catch (error) {
    log(
      label,
      error instanceof Expected
        ? `${error.constructor.name}: ${error.message}`
        : `错误类型不符：${String(error)}`,
    );
  }
}

/** 只取名，避免整行输出淹没重点。 */
const names = (rows: readonly { name: string | null }[]): Array<string | null> => rows.map((row) => row.name);

/** node:sqlite 返回的是 null 原型对象，转成普通对象后打印更干净。 */
const plain = <T extends object>(row: T): T => ({ ...row });
const plainRows = <T extends object>(rows: T[]): T[] => rows.map((row) => ({ ...row }));

/* ────────────────────────── 1. 打开数据库 ────────────────────────── */

section('1. 打开数据库');

const dir = mkdtempSync(join(tmpdir(), 'ormlet-example-'));
const file = join(dir, 'app.db');

// 选项全部可选：busyTimeout 默认 5000ms，journalMode 默认 'WAL'。
const db = new Database(file, { busyTimeout: 2_000, journalMode: 'WAL' });

log('db.isOpen', db.isOpen);
log('db.busyTimeout', db.busyTimeout);
log('journal_mode', plain(db.prepare('PRAGMA journal_mode').get() as object));

// 内存库：进程退出即消失，最适合测试替身；journalMode 对它是空操作。
const memory = new Database(':memory:');
memory.model('Ping', { tableName: 'ping', fields: { note: 'TEXT' } });
log('内存库可用', plain(memory.prepare(`SELECT COUNT(*) AS n FROM "ping"`).get() as object));
memory.close();

// 回滚日志模式：读事务会阻塞写，只在特殊场景使用；WAL 是默认值。
const rollbackMode = new Database(join(dir, 'rollback.db'), { journalMode: 'DELETE' });
log('journalMode: "DELETE"', plain(rollbackMode.prepare('PRAGMA journal_mode').get() as object));
rollbackMode.close();

/* ────────────────────────── 2. 定义模型 ────────────────────────── */

section('2. 定义模型（注册即自动建表）');

const User = db.model('User', {
  tableName: 'users',
  fields: {
    name: 'TEXT',
    email: 'TEXT',
    bio: 'TEXT',
    age: 'INTEGER',
    score: 'REAL',
    avatar: 'BLOB',
  },
});

log('模型名 / 表名', `${User.name} / ${User.tableName}`);
log('User.fields（冻结的副本）', { ...User.fields });
log('User.fields 已冻结', Object.isFrozen(User.fields));
log('自动生成的 DDL', (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'users'`).get() as { sql: string }).sql);

// 索引不由本库创建，用裸 SQL 补；唯一索引是 upsert({ on: ['email'] }) 的前提。
// IF NOT EXISTS 让这段可以放在启动流程里反复执行。
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users ("email")');
db.exec('CREATE INDEX IF NOT EXISTS users_age ON users ("age")');

/* ────────────────────────── 3. 新增 ────────────────────────── */

section('3. 新增（create）');

// 返回完整行：id 由 SQLite 分配，createdAt / updatedAt 自动写入且取值相同。
const zhangsan = User.create({
  name: '张三',
  email: 'zhangsan@example.com',
  bio: '后端工程师，喜欢 TypeScript',
  age: 28,
  score: 88.5,
});
log('create 全部字段', zhangsan);

// 省略与显式 null 等价：都写入 NULL。
const wangwu = User.create({ name: '王五', email: null, age: 19 });
log('未提供的字段为 null', { email: wangwu.email, score: wangwu.score, avatar: wangwu.avatar });

// BLOB 写入 Uint8Array，读回仍然是 Uint8Array。
const zhaoliu = User.create({
  name: 'Zhao Liu',
  email: 'zhao@example.com',
  bio: 'SRE',
  age: 45,
  score: 76.5,
  avatar: new Uint8Array([1, 2, 3]),
});
log('BLOB 往返无损', zhaoliu.avatar);

User.create({ name: '李四', email: 'lisi@example.com', bio: '前端工程师', age: 34, score: 92 });

// 批量插入（详见第 10 节）：默认要求每行字段集合一致，这里都用 name/age/score/email 四个键。
const seedIds = User.createMany(
  [
    { name: '陈七', age: 22, score: 61, email: 'chen@example.com' },
    { name: '周八', age: 28, score: 55.5, email: 'zhou@example.com' },
    { name: '吴九', age: 57, score: 99, email: 'wu@example.com' },
    { name: '郑十', age: 34, score: null, email: 'zheng@example.com' },
    { name: '孙一', age: 41, score: 72.25, email: 'sun@example.com' },
    { name: '钱二', age: 19, score: 45, email: 'qian@example.com' },
    { name: '冯三', age: 63, score: 81, email: null },
    { name: '褚四', age: 50, score: 68, email: 'chu@example.com' },
  ],
  { chunkSize: 100 },
);
log('createMany 返回自增 id', seedIds);
log('当前总行数', User.count());

// 写入路径的校验：未知字段、类型不匹配、托管列都抛 ValidationError。
// 这里用 as never 绕过编译期检查，专门验证运行期的第二道防线。
expectError('未知字段', ValidationError, () => User.create({ nickname: '小明' } as never));
expectError('类型不匹配', ValidationError, () => User.create({ name: 123 } as never));
expectError('传入托管列', ValidationError, () => User.create({ name: 'x', id: 1 } as never));
expectError('空数据', ValidationError, () => User.create({}));

/* ────────────────────────── 4. 单行读取 ────────────────────────── */

section('4. 单行读取');

log('findById', User.findById(zhangsan.id)?.name);
log('findById(不存在)', User.findById(999_999));

// 字段投影：返回类型随之收窄为 { id, name }，大字段（BLOB / 长 TEXT）不会被读出来。
const projected: { id: number; name: string | null } | undefined = User.findById(zhangsan.id, {
  select: ['id', 'name'],
});
log('findById + select', projected);

log('findOne', User.findOne({ email: 'lisi@example.com' })?.name);
log('findOne（无匹配）', User.findOne({ email: 'nobody@example.com' }));
log('exists', User.exists({ email: 'lisi@example.com' }));
log('exists（无匹配）', User.exists({ email: 'nobody@example.com' }));

// findByIds：结果长度恒等于入参长度，位置一一对应，不存在的 id 为 undefined。
log('findByIds([2, 1, 999999])', User.findByIds([2, 1, 999_999]).map((row) => row?.name ?? null));
log('findByIds([])', User.findByIds([]));

/* ────────────────────────── 5. 条件查询 ────────────────────────── */

section('5. 条件查询（全部操作符）');

log('等值 { age: 28 }', names(User.findMany({ age: 28 })));
log('eq / ne { email: { ne: "lisi@example.com" } }', User.findMany({ email: { ne: 'lisi@example.com' } }).length);
log('范围 { age: { gte: 30, lt: 60 } }', names(User.findMany({ age: { gte: 30, lt: 60 } })));
log('集合 { age: { in: [19, 63] } }', names(User.findMany({ age: { in: [19, 63] } })));
log('区间 { score: { between: [80, 95] } }', names(User.findMany({ score: { between: [80, 95] } })));
log('判空 { email: { isNull: true } }', names(User.findMany({ email: { isNull: true } })));
log('非空 { email: { isNull: false } }', User.findMany({ email: { isNull: false } }).length);
log('多字段之间是 AND { age: { gte: 30 }, score: { gte: 80 } }', names(User.findMany({ age: { gte: 30 }, score: { gte: 80 } })));

// 托管列（id / createdAt / updatedAt）在读取位置同样可用，且大小写不敏感。
log('托管列作条件 { ID: { in: [1, 2] } }', names(User.findMany({ ID: { in: [1, 2] } } as never)));
log(
  'createdAt 作条件 { createdAt: { gte: "1970-01-01T00:00:00.000Z" } }',
  User.count({ createdAt: { gte: '1970-01-01T00:00:00.000Z' } }),
);

// undefined 表示「该字段不参与筛选」，null 会被拒绝（SQL 里 column = NULL 永远不成立）。
log('{ age: 28, score: undefined } 等价于 { age: 28 }', User.findMany({ age: 28, score: undefined }).length);
expectError('条件传 null', ValidationError, () => User.findMany({ email: null }));
expectError('未知操作符', ValidationError, () => User.findMany({ age: { like: 1 } } as never));
expectError('非法 id', ValidationError, () => User.findById(0));

// 三值逻辑：ne 不会命中 NULL 行，所以「不等于 92 的行数」+「等于 92 的行数」≠ 总数。
const notLisi = User.count({ score: { ne: 92 } });
const isLisi = User.count({ score: 92 });
log('score != 92 / score = 92 / 总数', [notLisi, isLisi, User.count()]);
log('差值来自 score IS NULL 的行', names(User.findMany({ score: { isNull: true } })));

/* ────────────────────────── 6. 排序 / 分页 / 投影 ────────────────────────── */

section('6. 排序 / 分页 / 字段投影');

log('默认 id DESC', names(User.findMany(undefined, { limit: 3 })));
log('按 age ASC', names(User.findMany(undefined, { orderBy: 'age', order: 'ASC', limit: 3 })));
log(
  '按 age DESC 取第 2 页（每页 3 条）',
  names(User.findMany(undefined, { orderBy: 'age', order: 'DESC', limit: 3, offset: 3 })),
);
log('按托管列排序 orderBy: "createdAt"', User.findMany(undefined, { orderBy: 'createdAt', order: 'ASC', limit: 1 })[0]?.id);
log(
  'select: ["id", "name", "age"]',
  User.findMany({ age: { gte: 30 } }, { select: ['id', 'name', 'age'], orderBy: 'age', order: 'ASC', limit: 3 }),
);

// 分页元信息：总数用同一组条件算，别用当页条数推断。
const pageSize = 3;
const total = User.count({ age: { gte: 30 } });
log('分页元信息', { pageSize, total, totalPages: Math.ceil(total / pageSize) });

expectError('limit: 0', ValidationError, () => User.findMany(undefined, { limit: 0 }));
expectError('offset 缺少 limit', ValidationError, () => User.findMany(undefined, { offset: 5 }));
expectError('未知排序字段', ValidationError, () => User.findMany(undefined, { orderBy: 'nick' as never }));
expectError('findOne 不接受 limit', ValidationError, () => User.findOne({}, { limit: 2 } as never));

/* ────────────────────────── 7. 关键字搜索与统计 ────────────────────────── */

section('7. 关键字搜索与统计');

// 对全部 TEXT 字段做 OR LIKE；ASCII 大小写不敏感，中文精确匹配。
log('search("工程师")', names(User.search('工程师')));
log('search("zhang")（命中 Email 的大小写变体）', names(User.search('zhang')));
log('search("TypeScript", { fields: ["bio"] })', names(User.search('TypeScript', { fields: ['bio'] })));
log(
  'search + 排序分页 + 投影',
  User.search('example', { fields: ['email'], orderBy: 'name', order: 'ASC', limit: 3, select: ['name'] }),
);
log('搜索结果总数 count(undefined, { keyword: "example" })', User.count(undefined, { keyword: 'example' }));
// `%` 是 LIKE 通配符（原样生效，不会被转义）；NULL 行不命中，因此只算有邮箱的 10 行。
log('search("%", { fields: ["email"] })', User.search('%', { fields: ['email'] }).length);

// COUNT(col) 只统计该列非 NULL 的行，与 count() 相减即缺失数。
const withEmail = User.count(undefined, { column: 'email' });
log('count(undefined, { column: "email" }) / count()', [withEmail, User.count()]);
log('没有邮箱的行数', User.count() - withEmail);

expectError('非 TEXT 字段参与搜索', ValidationError, () => User.search('x', { fields: ['age'] } as never));
expectError('只传 fields 不传 keyword', ValidationError, () => User.count(undefined, { fields: ['name'] } as never));
expectError('空关键字', ValidationError, () => User.search(''));

/* ────────────────────────── 8. 游标分页 ────────────────────────── */

section('8. 游标分页（findPage）');

let cursor: Cursor | null = null;
let page = 0;
for (;;) {
  // 显式标注返回值，避免 TS 在「游标 → 下一页查询」的循环推断上自我引用
  const result: Page<ReturnType<typeof User.create>> = User.findPage({
    orderBy: 'age',
    order: 'ASC',
    limit: 5,
    after: cursor,
  });
  page += 1;
  console.log(
    `  第 ${page} 页 → ${JSON.stringify(names(result.items))}` +
      `  hasMore=${result.hasMore}  nextCursor=${JSON.stringify(result.nextCursor)}`,
  );
  if (!result.hasMore) break;
  cursor = result.nextCursor;
}

// select 与游标的配合：排序字段和 id 会被自动补进 SQL，但类型只反映 select 里写出的列。
const projectedPage = User.findPage({ orderBy: 'age', order: 'ASC', limit: 2, select: ['id', 'name', 'age'] });
log('findPage + select', projectedPage.items);
expectError('findPage 不接受 offset', ValidationError, () =>
  User.findPage({ offset: 10 } as never),
);

/* ────────────────────────── 9. 更新与删除 ────────────────────────── */

section('9. 更新与删除');

const before = User.findById(zhangsan.id)!;
const updated = User.update(zhangsan.id, { age: 29, bio: '后端工程师 / 架构' });
log('update 返回更新后的整行', { age: updated?.age, bio: updated?.bio });
log('updatedAt 已刷新', { before: before.updatedAt, after: updated?.updatedAt });
log('createdAt 未被改动', before.createdAt === updated?.createdAt);
log('update 不存在的 id', User.update(999_999, { age: 1 }));
expectError('update 空对象', ValidationError, () => User.update(zhangsan.id, {}));
expectError('update 传主键', ValidationError, () => User.update(zhangsan.id, { id: 2 } as never));

// delete 返回被删除那一行的快照，可直接写审计日志。
const temp = User.create({ name: '待删除', age: 1 });
log('delete 返回快照', User.delete(temp.id));
log('再删同一 id', User.delete(temp.id));

/* ────────────────────────── 10. 批量写入 / upsert ────────────────────────── */

section('10. 批量写入 / upsert');

// 第二个模型：演示多模型共享同一连接，也让 users 表在后半段保持稳定。
const Task = db.model('Task', {
  tableName: 'tasks',
  fields: {
    code: 'TEXT',
    title: 'TEXT',
    status: 'TEXT',
    priority: 'INTEGER',
    ownerId: 'INTEGER',
  },
});
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS tasks_code ON tasks ("code")');

const statuses = ['todo', 'doing', 'done'] as const;
const taskRows = Array.from({ length: 25 }, (_, index) => ({
  code: `T-${String(index + 1).padStart(2, '0')}`,
  title: `任务 ${index + 1}`,
  status: statuses[index % statuses.length],
  priority: (index % 3) + 1,
  ownerId: (index % 4) + 1,
}));

// chunkSize 控制单条 INSERT 携带的行数；整批共用同一个时间戳，并整体在一个事务中。
const taskIds = Task.createMany(taskRows, { chunkSize: 10 });
log('createMany 返回条数', taskIds.length);
log(
  '整批 createdAt 取值数（同一时刻）',
  new Set(Task.findByIds(taskIds).map((row) => row?.createdAt)).size,
);

// strictFields：默认要求各行字段一致；显式关掉后按 SQL 默认值补缺失列。
expectError('各行字段不一致', ValidationError, () => User.createMany([{ name: '甲' }, { name: '乙', age: 1 }]));
log(
  'strictFields: false',
  User.createMany([{ name: '甲' }, { name: '乙', age: 1 }], { strictFields: false }),
);

// upsert：冲突目标上必须有唯一约束（这里是 tasks_code）。
log(
  'upsert 插入（T-50 尚不存在）',
  Task.upsert({ code: 'T-50', title: '任务 50（覆盖）', status: 'doing', priority: 5 }, { on: ['code'] }),
);
log(
  'upsert 冲突 → 只更新指定列',
  Task.upsert({ code: 'T-50', title: '任务 50' }, { on: ['code'], update: { priority: 8 } }),
);
log(
  'upsert 冲突 → update: {} 即 DO NOTHING',
  Task.upsert({ code: 'T-50', title: '不会生效' }, { on: ['code'], update: {} }),
);
log(
  'upsertMany 返回影响行数',
  Task.upsertMany(
    [
      { code: 'T-50', title: '任务 50', status: 'done', priority: 1, ownerId: 1 },
      { code: 'T-99', title: '新增任务', status: 'todo', priority: 2, ownerId: 2 },
    ],
    { on: ['code'] },
  ),
);
// 目标列没有唯一约束时 SQLite 直接报错，本库包装为 SqlModelError（原始信息在 cause 上）。
expectError('冲突目标没有唯一约束', SqlModelError, () =>
  Task.upsert({ code: 'T-98', title: 'x' }, { on: ['title'] }),
);

/* ────────────────────────── 11. 批量更新与删除 ────────────────────────── */

section('11. 批量更新与删除');

// 返回 { changes, statements }；statements 是实际执行的 UPDATE 条数（按 chunkSize 分批）。
log(
  'updateMany({ status: "todo" }, { priority: 9 }, { chunkSize: 2 })',
  Task.updateMany({ status: 'todo' }, { priority: 9 }, { chunkSize: 2 }),
);
log('更新后 todo 的 priority 取值', Task.findMany({ status: 'todo' }, { select: ['priority'], limit: 3 }));
log('deleteMany({ status: "done" })', Task.deleteMany({ status: 'done' }));
expectError('deleteMany 无条件', ValidationError, () => Task.deleteMany(undefined as never));
expectError('deleteMany 空条件', ValidationError, () => Task.deleteMany({}));
expectError('confirm 取值非法', ValidationError, () =>
  Task.deleteMany({ status: 'none' }, { confirm: 'yes' } as never),
);
log('剩余行数', Task.count());

// 清空整表：clear() 或 deleteMany({}, { confirm: 'all' })，两者等价。
log('clear({ chunkSize: 10 })', Task.clear({ chunkSize: 10 }));
log('空表上再 clear()', Task.clear());
const afterClear = Task.create({ code: 'T-100', title: '清空后新建', status: 'todo', priority: 1, ownerId: 1 });
log('clear 不重置自增序列，新行 id 继续往后走', afterClear.id);

/* ────────────────────────── 12. 事务 ────────────────────────── */

section('12. 事务');

// 回调收到 db 本身，返回值原样返回；事务内可以直接调用模型方法（会加入外层事务）。
const insideCount = db.transaction((tx) => {
  log('  事务内 db.inTransaction', tx.inTransaction);
  Task.create({ code: 'T-101', title: '事务内创建', status: 'todo', priority: 2, ownerId: 1 });
  Task.create({ code: 'T-102', title: '事务内创建', status: 'todo', priority: 2, ownerId: 1 });
  return Task.count({ status: 'todo' });
});
log('transaction 返回值', insideCount);
log('提交后 inTransaction', db.inTransaction);

// 抛错即整体回滚，原错误原样抛出（不会被包装）。
expectError('回调抛错 → 回滚', Error, () =>
  db.transaction(() => {
    Task.create({ code: 'T-103', title: '将被回滚', status: 'todo', priority: 1, ownerId: 1 });
    throw new Error('业务校验失败');
  }),
);
log('回滚后 T-103 是否存在', Task.exists({ code: 'T-103' }));

expectError('嵌套 transaction', TransactionError, () => db.transaction(() => db.transaction(() => 0)));

// 手动开启的事务同样可以回滚；没有事务时 rollback() 返回 false。
db.exec('BEGIN IMMEDIATE');
Task.create({ code: 'T-104', title: '手动事务', status: 'todo', priority: 1, ownerId: 1 });
log('手动 BEGIN 后 inTransaction', db.inTransaction);
log('rollback()', db.rollback());
log('回滚后 T-104 是否存在', Task.exists({ code: 'T-104' }));
log('无事务时 rollback()', db.rollback());

/* ────────────────────────── 13. 字段同步与删除 ────────────────────────── */

section('13. 字段同步与删除');

// 表由外部 SQL 创建（没有时间戳列，也没有 summary）→ 注册模型时自动补齐。
db.exec(`CREATE TABLE IF NOT EXISTS "legacy_notes" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "body" TEXT) STRICT`);
const Note = db.model('Note', { tableName: 'legacy_notes', fields: { body: 'TEXT', summary: 'TEXT' } });
log(
  '注册后表结构',
  (db.prepare(`SELECT name FROM pragma_table_info('legacy_notes')`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  ),
);
log('syncFields() 幂等', Note.syncFields());

// deleteField 只允许删「模型未声明」的列，先加一列模拟模型已移除字段的历史遗留。
db.exec('ALTER TABLE "users" ADD COLUMN "legacyFlag" TEXT');
log('deleteField("legacyFlag")', User.deleteField('legacyFlag'));
log('再删一次（列已不存在）', User.deleteField('legacyFlag'));
expectError('删模型声明的字段', ValidationError, () => User.deleteField('name'));
expectError('删主键', ValidationError, () => User.deleteField('id'));
expectError('删时间戳列', ValidationError, () => User.deleteField('createdAt'));

// 该列上有索引时 DROP COLUMN 会失败，原始原因在 error.cause 上。
db.exec('ALTER TABLE "users" ADD COLUMN "indexedFlag" TEXT');
db.exec('CREATE INDEX IF NOT EXISTS users_indexed_flag ON users ("indexedFlag")');
try {
  User.deleteField('indexedFlag');
} catch (error) {
  log('撞索引时的错误信息（已脱敏）', (error as Error).message);
  log('原始原因（error.cause）', (error as { cause?: Error }).cause?.message);
}
db.exec('DROP INDEX IF EXISTS users_indexed_flag');
log('先删索引再删列', User.deleteField('indexedFlag'));

/* ────────────────────────── 14. 索引与逃生舱 ────────────────────────── */

section('14. 索引与逃生舱（裸 SQL）');

// db.exec：可含多条语句，无返回值。索引名 / 表名只能来自代码常量。
db.exec(`
  CREATE INDEX IF NOT EXISTS users_score ON users ("score");
  CREATE INDEX IF NOT EXISTS users_score ON users ("score");
`);
log(
  '索引清单',
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' ORDER BY name`).all() as Array<{
    name: string;
  }>).map((index) => index.name),
);

// EXPLAIN QUERY PLAN：出现 SEARCH ... USING INDEX 才是走索引，SCAN 是全表扫描。
log(
  'EXPLAIN QUERY PLAN（email 等值）',
  plainRows(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM "users" WHERE "email" = ?').all('lisi@example.com') as object[]),
);

// db.prepare：预编译语句可复用，值一律用 ? 绑定，不要拼接。
const byAge = db.prepare('SELECT "name", "age" FROM "users" WHERE "age" >= ? ORDER BY "age" LIMIT ?');
log('prepared statement', plainRows(byAge.all(40, 3) as object[]));
log('prepared statement 复用', plainRows(byAge.all(55, 2) as object[]));

// 迁移版本号：PRAGMA user_version 由 SQLite 保存，本库不占用它。
log('user_version 读取', plain(db.prepare('PRAGMA user_version').get() as object));
db.exec('PRAGMA user_version = 2');
log('user_version 写入后', plain(db.prepare('PRAGMA user_version').get() as object));

// 备份：连接打开时也能得到一致快照（路径无法参数绑定，必须来自常量）。
const backup = join(dir, 'backup.db').replaceAll('\\', '/');
db.exec(`VACUUM INTO '${backup}'`);
log('备份文件大小（字节）', statSync(backup).size);

/* ────────────────────────── 15. 锁与并发 ────────────────────────── */

section('15. 锁与并发');

// 同一文件的第二个连接：读到的数据一致，但写与写互斥。
const other = new Database(file, { busyTimeout: 0, journalMode: 'WAL' });
log('第二个连接读到相同行数', plain(other.prepare('SELECT COUNT(*) AS n FROM "users"').get() as object));

other.exec('BEGIN IMMEDIATE'); // 持有一个写事务
db.setBusyTimeout(0); // 不等待：冲突立即暴露，而不是阻塞事件循环
log('db.isLocked()', db.isLocked());
try {
  User.create({ name: '锁竞争', age: 1 });
} catch (error) {
  if (error instanceof LockTimeoutError) log('捕获 LockTimeoutError', error.message);
  else log('其它错误', String(error));
  log('isLockConflict(error)（可识别被上层包装过的锁错误）', isLockConflict(error));
}

other.exec('ROLLBACK');
log('释放写锁后 db.isLocked()', db.isLocked());
db.setBusyTimeout(2_000);
other.close();

// reopenAfterReadOnly：正常路径无需调用（只读错误会自动恢复），这里只演示契约。
attempt('db.reopenAfterReadOnly()', () => db.reopenAfterReadOnly());

/* ────────────────────────── 16. 错误类型 ────────────────────────── */

section('16. 错误类型');

// 唯一约束：users_email 唯一索引冲突。
try {
  User.create({ name: '重复邮箱', email: 'zhangsan@example.com' });
} catch (error) {
  if (error instanceof UniqueConstraintError) log('UniqueConstraintError', error.message);
  else throw error;
}

// 批量插入中任一行违反约束 → 整批回滚，不会留下「插了一半」的状态。
expectError('批量中的唯一冲突', UniqueConstraintError, () =>
  User.createMany([
    { name: '批量冲突', email: 'chen@example.com' }, // 已存在
    { name: '批量正常', email: 'batch@example.com' },
  ]),
);
log('整批回滚后 batch@example.com 不存在', User.exists({ email: 'batch@example.com' }));

// 外部建表时写的约束同样生效：STRICT 之外，NOT NULL / CHECK / 外键都是真实约束。
db.exec(`
  CREATE TABLE IF NOT EXISTS "inventory" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "createdAt" TEXT,
    "updatedAt" TEXT,
    "sku" TEXT NOT NULL,
    "qty" INTEGER CHECK ("qty" >= 0)
  ) STRICT
`);
const Item = db.model('Item', { tableName: 'inventory', fields: { sku: 'TEXT', qty: 'INTEGER' } });
expectError('NOT NULL 冲突', NotNullConstraintError, () => Item.create({ qty: 3 }));
expectError('CHECK 冲突', CheckConstraintError, () => Item.create({ sku: 'A-1', qty: -1 }));
const item = Item.create({ sku: 'A-1', qty: 3 });
log('合法写入', { id: item.id, sku: item.sku, qty: item.qty });

db.exec(`
  CREATE TABLE IF NOT EXISTS "posts" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "createdAt" TEXT,
    "updatedAt" TEXT,
    "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "title" TEXT
  ) STRICT
`);
const Post = db.model('Post', { tableName: 'posts', fields: { userId: 'INTEGER', title: 'TEXT' } });
expectError('外键：父行不存在', ForeignKeyConstraintError, () => Post.create({ userId: 999_999, title: '孤儿帖' }));
const post = Post.create({ userId: zhangsan.id, title: '第一篇文章' });
log('合法写入', { id: post.id, userId: post.userId, title: post.title });

// 模型层表达不了的 JOIN / 子查询，用 Model.db 走同一个连接与事务。
log(
  'User.db 做 JOIN',
  plainRows(
    User.db
      .prepare(
        `SELECT u."name" AS name, COUNT(p."id") AS posts
         FROM "users" u JOIN "posts" p ON p."userId" = u."id"
         GROUP BY u."id" ORDER BY posts DESC`,
      )
      .all() as object[],
  ),
);

// 模型定义的校验错误。
expectError('表名已被占用', InvalidModelError, () => db.model('Other', { tableName: 'users', fields: { name: 'TEXT' } }));
expectError('同名但定义不同', InvalidModelError, () => db.model('User', { tableName: 'users', fields: { name: 'TEXT' } }));
expectError('声明托管字段', InvalidModelError, () => db.model('Bad', { tableName: 'bad', fields: { id: 'INTEGER' } }));
expectError('非法表名', InvalidModelError, () => db.model('Bad2', { tableName: 'bad-table', fields: { x: 'TEXT' } }));
expectError('非法字段类型', InvalidModelError, () => db.model('Bad3', { tableName: 'bad3', fields: { x: 'DATE' } as never }));

/* ────────────────────────── 17. 模型实例 ────────────────────────── */

section('17. 模型实例');

// 幂等注册：同名 + 同定义返回同一个实例，各模块可以各自声明模型。
const SameUser = db.model('User', {
  tableName: 'users',
  fields: { name: 'TEXT', email: 'TEXT', bio: 'TEXT', age: 'INTEGER', score: 'REAL', avatar: 'BLOB' },
});
log('重复注册是同一实例', SameUser === User);

// 方法在构造时绑定，可以安全解构 / 当回调传递。
const { create: createUser, count: countUsers } = User;
createUser({ name: '解构创建', age: 30 });
log('解构后的 count()', countUsers());
log('User.db === db', User.db === db);
log(
  '绑定方法是非枚举自有属性',
  Object.prototype.hasOwnProperty.call(User, 'create') &&
    Object.getOwnPropertyDescriptor(User, 'create')?.enumerable === false,
);
log('Object.keys(User)', Object.keys(User));

// 反射字段声明：通用后台 / 动态表单 / 导出表头不必另存一份定义。
log(
  '按类型分组字段',
  Object.entries(User.fields).reduce<Record<string, string[]>>((groups, [field, type]) => {
    (groups[type] ??= []).push(field);
    return groups;
  }, {}),
);

/* ────────────────────────── 18. 关闭数据库 ────────────────────────── */

section('18. 关闭数据库');

log('close 前 isOpen', db.isOpen);
db.close();
db.close(); // 幂等，可安全重复调用
log('close 后 isOpen', db.isOpen);

expectError('关闭后查询', DatabaseClosedError, () => User.count());
expectError('关闭后注册模型', DatabaseClosedError, () => db.model('Later', { tableName: 'later', fields: { a: 'TEXT' } }));
expectError('关闭后开启事务', DatabaseClosedError, () => db.transaction(() => 1));

rmSync(dir, { recursive: true, force: true });

console.log('\n全部示例执行完毕，临时数据库目录已清理。');
