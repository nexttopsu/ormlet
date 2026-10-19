import { afterEach, beforeEach, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  CheckConstraintError,
  ConstraintError,
  Database,
  DatabaseClosedError,
  ForeignKeyConstraintError,
  NotNullConstraintError,
  SqlModelError,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
} from '../src/index.js';
import type { Cursor, Model, ModelRow, Page, PageOptions } from '../src/index.js';

// 传入故意非法的参数时绕过编译期检查，测试运行时校验
const invalid = (value: unknown): never => value as never;

type UserFields = {
  name: 'TEXT';
  age: 'INTEGER';
  email: 'TEXT';
  score: 'REAL';
};

let db: Database;
let User: Model<UserFields>;

beforeEach(() => {
  db = new Database(':memory:');
  User = db.model('User', {
    tableName: 'users',
    fields: { name: 'TEXT', age: 'INTEGER', email: 'TEXT', score: 'REAL' },
  });
});

afterEach(() => {
  db.close();
});

describe('transaction', () => {
  test('commits and returns the callback result', () => {
    const result = db.transaction(() => {
      User.create({ name: 'a', age: 20 });
      User.create({ name: 'b', age: 30 });
      assert.equal(db.inTransaction, true);
      return User.count();
    });
    assert.equal(result, 2);
    assert.equal(db.inTransaction, false);
    assert.equal(User.count(), 2);
  });

  test('rolls back every write when the callback throws and rethrows the original error', () => {
    const boom = new Error('boom');
    assert.throws(
      () =>
        db.transaction(() => {
          User.create({ name: 'a' });
          throw boom;
        }),
      (error: unknown) => error === boom,
    );
    assert.equal(User.count(), 0);
    assert.equal(db.inTransaction, false);
  });

  test('rolls back on validation errors raised by model methods', () => {
    assert.throws(() =>
      db.transaction(() => {
        User.create({ name: 'a' });
        User.create(invalid({ unknownField: 'x' }));
      }),
    );
    assert.equal(User.count(), 0);
  });

  test('rejects nesting instead of silently opening a savepoint', () => {
    assert.throws(
      () => db.transaction(() => db.transaction(() => 1)),
      TransactionError,
    );
    // 外层事务已被回滚，数据库可继续使用
    assert.equal(db.inTransaction, false);
    assert.equal(db.transaction(() => User.count()), 0);
  });

  test('rejects running inside an externally opened transaction', () => {
    db.exec('BEGIN');
    assert.throws(() => db.transaction(() => 1), TransactionError);
    db.rollback();
  });

  test('rejects a non-function argument and a closed database', () => {
    assert.throws(() => db.transaction(invalid(42)), ValidationError);
    db.close();
    assert.throws(
      () =>
        db.transaction(() => 1),
      DatabaseClosedError,
    );
  });

  test('reports a DatabaseClosedError when close() is called inside the callback', () => {
    assert.throws(
      () =>
        db.transaction(() => {
          db.close();
        }),
      DatabaseClosedError,
    );
  });

  test('is atomic for bulk helpers and exposes changes', () => {
    const result = db.transaction(() => User.createMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]));
    assert.deepEqual(result, [1, 2, 3]);
  });
});

describe('where operators', () => {
  beforeEach(() => {
    // 字段集合必须一致（createMany 默认 strictFields），缺失的值显式传 null
    User.createMany([
      { name: 'a', age: 10, score: 1.5, email: null },
      { name: 'b', age: 20, score: 2.5, email: null },
      { name: 'c', age: 30, score: null, email: 'c@example.com' },
      { name: 'd', age: 40, score: null, email: 'd@example.com' },
    ]);
  });

  const names = (rows: { name: string | null }[]) => rows.map((row) => row.name);

  test('keeps scalar values as equality', () => {
    assert.deepEqual(names(User.findMany({ age: 20 })), ['b']);
    assert.equal(User.count({ name: 'a' }), 1);
  });

  test('supports eq / ne', () => {
    assert.deepEqual(names(User.findMany({ age: { eq: 30 } })), ['c']);
    assert.deepEqual(names(User.findMany({ age: { ne: 30 }, }, { orderBy: 'age', order: 'ASC' })), [
      'a',
      'b',
      'd',
    ]);
  });

  test('supports gt / gte / lt / lte with several operators on one field (AND)', () => {
    assert.equal(User.count({ age: { gte: 30 } }), 2);
    assert.equal(User.count({ age: { gt: 10, lt: 40 } }), 2);
    assert.equal(User.count({ age: { gte: 10, lte: 40 } }), 4);
    assert.equal(User.count({ score: { lt: 2 } }), 1);
  });

  test('supports in and between', () => {
    assert.deepEqual(names(User.findMany({ age: { in: [10, 40] } }, { orderBy: 'age', order: 'ASC' })), [
      'a',
      'd',
    ]);
    assert.equal(User.count({ age: { between: [20, 30] } }), 2);
    assert.equal(User.count({ name: { in: ['a', 'b', 'a'] } }), 2);
  });

  test('supports isNull / isNull: false', () => {
    assert.equal(User.count({ email: { isNull: true } }), 2);
    assert.equal(User.count({ email: { isNull: false } }), 2);
    assert.deepEqual(names(User.findMany({ email: { isNull: false } }, { orderBy: 'age', order: 'ASC' })), [
      'c',
      'd',
    ]);
  });

  test('combines several fields with AND', () => {
    assert.deepEqual(names(User.findMany({ age: { gte: 20 }, email: { isNull: false } })), ['d', 'c']);
  });

  test('rejects unknown operators, empty condition objects and null values', () => {
    assert.throws(() => User.findMany(invalid({ age: { like: 1 } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ age: {} })), ValidationError);
    assert.throws(() => User.findMany(invalid({ age: null })), ValidationError);
    assert.throws(() => User.count(invalid({ age: { eq: null } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ unknownField: { gte: 1 } })), ValidationError);
  });

  test('rejects values that do not match the field type', () => {
    assert.throws(() => User.findMany(invalid({ age: { gte: '10' } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ age: { in: [1, '2'] } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ age: { in: [] } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ age: { in: [null] } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ age: { between: [1] } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ email: { isNull: 'yes' } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ name: { gt: 1 } })), ValidationError);
  });

  test('supports long IN lists by splitting them into several placeholders groups', () => {
    // 1200 项超过单段 500 的上限，会被拆成多段并用 OR 连接；
    // 40 落在第 2 段，能命中说明各段都参与了匹配
    const ages = Array.from({ length: 1200 }, (_, i) => i);
    assert.equal(User.count({ age: { in: ages } }), 4);
    assert.equal(User.count({ age: { in: [40] } }), 1);
    // 3 段以上：偏移到 10..49 后命中 10 / 20 / 30 / 40
    assert.equal(User.count({ age: { in: Array.from({ length: 1500 }, (_, i) => (i % 40) + 10) } }), 4);
    // 偏移到 1..40（含 40）仍命中全部四行
    assert.equal(User.count({ age: { in: Array.from({ length: 1500 }, (_, i) => (i % 39) + 2) } }), 4);
  });

  test('works with pagination and sorting', () => {
    const page = User.findMany({ age: { gte: 20 } }, { orderBy: 'age', order: 'ASC', limit: 2, offset: 1 });
    assert.deepEqual(names(page), ['c', 'd']);
  });
});

describe('createMany', () => {
  test('inserts all rows and returns ids in order', () => {
    const ids = User.createMany([
      { name: 'a', age: 1 },
      { name: 'b', age: 2 },
      { name: 'c', age: 3 },
    ]);
    assert.deepEqual(ids, [1, 2, 3]);
    assert.equal(User.count(), 3);
    assert.equal(User.findById(2)?.name, 'b');
  });

  test('handles large batches by chunking', () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ name: `u${i}`, age: i % 100 }));
    const ids = User.createMany(rows, { chunkSize: 200 });
    assert.equal(ids.length, 2500);
    assert.equal(new Set(ids).size, 2500);
    assert.equal(User.count(), 2500);
    assert.equal(User.findById(ids[2499]!)?.name, 'u2499');
  });

  test('writes the same timestamp to the whole batch', () => {
    User.createMany([{ name: 'a' }, { name: 'b' }]);
    const rows = User.findMany();
    assert.equal(rows[0]!.createdAt, rows[1]!.createdAt);
  });

  test('returns an empty array for an empty input without executing anything', () => {
    assert.deepEqual(User.createMany([]), []);
    assert.equal(User.count(), 0);
  });

  test('rejects rows with different field sets by default', () => {
    assert.throws(() => User.createMany([{ name: 'a' }, { name: 'b', age: 1 }]), ValidationError);
  });

  test('fills missing fields with NULL when strictFields is false', () => {
    User.createMany([{ name: 'a' }, { name: 'b', age: 1 }], { strictFields: false });
    assert.equal(User.count(), 2);
    assert.equal(User.findMany({ age: { isNull: true } }).length, 1);
  });

  test('treats an explicit null and an omitted field alike', () => {
    assert.deepEqual(
      User.createMany(
        [
          { name: 'a', age: null },
          { name: 'b' },
        ],
        { strictFields: false },
      ),
      [1, 2],
    );
    assert.equal(User.findMany({ age: { isNull: true } }).length, 2);
  });

  test('is atomic: a failing row rolls back the whole batch', () => {
    assert.throws(() =>
      User.createMany([
        { name: 'a' },
        { name: 'b', age: invalid('not a number') as never },
      ]),
    );
    assert.equal(User.count(), 0);
  });

  test('rejects invalid input shapes and options', () => {
    assert.throws(() => User.createMany(invalid('nope')), ValidationError);
    assert.throws(() => User.createMany(invalid([null])), ValidationError);
    assert.throws(() => User.createMany(invalid([{ unknownField: 'x' }])), ValidationError);
    assert.throws(() => User.createMany(invalid([{}])), ValidationError);
    assert.throws(() => User.createMany([{ name: 'a' }], invalid({ chunkSize: 0 })), ValidationError);
    assert.throws(() => User.createMany([{ name: 'a' }], invalid({ chunkSize: 1.5 })), ValidationError);
    assert.throws(() => User.createMany([{ name: 'a' }], invalid({ unknown: true })), ValidationError);
    assert.throws(() => User.createMany([{ name: 'a' }], invalid({ strictFields: 'yes' })), ValidationError);
  });

  test('joins an outer transaction and is rolled back with it', () => {
    assert.throws(() =>
      db.transaction(() => {
        User.createMany([{ name: 'a' }, { name: 'b' }]);
        throw new Error('boom');
      }),
    );
    assert.equal(User.count(), 0);
  });
});

describe('updateMany', () => {
  beforeEach(() => {
    User.createMany([
      { name: 'a', age: 10 },
      { name: 'b', age: 20 },
      { name: 'c', age: 30 },
      { name: 'd', age: 40 },
    ]);
  });

  test('updates matching rows and reports changes', () => {
    const result = User.updateMany({ age: { gte: 30 } }, { email: 'senior@example.com' });
    assert.deepEqual(result, { changes: 2, statements: 1 });
    assert.equal(User.count({ email: 'senior@example.com' }), 2);
  });

  test('refreshes updatedAt for every updated row in one timestamp', () => {
    User.updateMany({}, { score: 9.5 });
    const rows = User.findMany();
    assert.equal(rows.every((row) => row.score === 9.5), true);
    assert.equal(new Set(rows.map((row) => row.updatedAt)).size, 1);
  });

  test('splits work into chunks and counts statements', () => {
    const result = User.updateMany({ age: { gt: 0 } }, { score: 1 }, { chunkSize: 3 });
    assert.equal(result.changes, 4);
    assert.equal(result.statements, 2);
  });

  test('returns zero changes when nothing matches', () => {
    assert.deepEqual(User.updateMany({ age: { lt: 0 } }, { score: 1 }), { changes: 0, statements: 0 });
  });

  test('rejects an empty update object and invalid options', () => {
    assert.throws(() => User.updateMany({}, {}), ValidationError);
    assert.throws(() => User.updateMany({}, { unknownField: 1 } as never), ValidationError);
    assert.throws(() => User.updateMany(invalid({ age: null }), { score: 1 }), ValidationError);
    assert.throws(() => User.updateMany({}, { score: 1 }, invalid({ chunkSize: 0 })), ValidationError);
    assert.throws(() => User.updateMany({}, { score: 1 }, invalid({ limit: 10 })), ValidationError);
  });

  test('rejects updating the primary key or timestamps', () => {
    assert.throws(() => User.updateMany({}, invalid({ id: 1 })), ValidationError);
    assert.throws(() => User.updateMany({}, invalid({ createdAt: '2020-01-01T00:00:00.000Z' })), ValidationError);
  });

  test('treats an undefined where as "all rows"', () => {
    assert.equal(User.updateMany(invalid(undefined), { score: 2 }).changes, 4);
  });
});

describe('deleteMany', () => {
  beforeEach(() => {
    User.createMany(
      Array.from({ length: 10 }, (_, i) => ({ name: `u${i}`, age: i })),
    );
  });

  test('deletes matching rows and reports changes', () => {
    assert.deepEqual(User.deleteMany({ age: { gte: 5 } }), { changes: 5, statements: 1 });
    assert.equal(User.count(), 5);
  });

  test('supports chunking', () => {
    const result = User.deleteMany({ age: { gte: 0 } }, { chunkSize: 4 });
    assert.equal(result.changes, 10);
    assert.equal(result.statements, 3);
    assert.equal(User.count(), 0);
  });

  test('returns zero when nothing matches', () => {
    assert.deepEqual(User.deleteMany({ age: { gt: 100 } }), { changes: 0, statements: 0 });
  });

  test('is atomic', () => {
    assert.throws(() =>
      db.transaction(() => {
        User.deleteMany({ age: { gte: 0 } });
        throw new Error('boom');
      }),
    );
    assert.equal(User.count(), 10);
  });
});

describe('upsert', () => {
  test('inserts when there is no conflict', () => {
    // on 指定的列必须有唯一约束，因此先建唯一索引
    db.exec('CREATE UNIQUE INDEX u_email ON users (email)');
    const row = User.upsert({ name: 'a', age: 1, email: 'a@example.com' }, { on: ['email'] });
    assert.equal(row.id, 1);
    assert.equal(row.name, 'a');
    assert.equal(row.createdAt, row.updatedAt);
  });

  test('updates on conflict and keeps createdAt', async () => {
    const db2 = new Database(':memory:');
    const M = db2.model('M', { tableName: 'm', fields: { key: 'TEXT', value: 'INTEGER' } });
    db2.exec('CREATE UNIQUE INDEX m_key ON m (key)');
    const first = M.upsert({ key: 'k', value: 1 }, { on: ['key'] });
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const second = M.upsert({ key: 'k', value: 2 }, { on: ['key'] });
    assert.equal(second.id, first.id);
    assert.equal(second.value, 2);
    assert.equal(second.createdAt, first.createdAt);
    assert.notEqual(second.updatedAt, first.updatedAt);
    assert.equal(M.count(), 1);
    db2.close();
  });

  test('only updates the fields given in options.update', () => {
    const db2 = new Database(':memory:');
    const M = db2.model('M', { tableName: 'm', fields: { key: 'TEXT', a: 'INTEGER', b: 'INTEGER' } });
    db2.exec('CREATE UNIQUE INDEX m_key ON m (key)');
    M.upsert({ key: 'k', a: 1, b: 1 }, { on: ['key'] });
    const row = M.upsert({ key: 'k', a: 2, b: 2 }, { on: ['key'], update: { a: 2 } });
    assert.equal(row.a, 2);
    assert.equal(row.b, 1);
    db2.close();
  });

  test('supports DO NOTHING when update is empty', () => {
    const db2 = new Database(':memory:');
    const M = db2.model('M', { tableName: 'm', fields: { key: 'TEXT', a: 'INTEGER' } });
    db2.exec('CREATE UNIQUE INDEX m_key ON m (key)');
    const first = M.upsert({ key: 'k', a: 1 }, { on: ['key'] });
    const again = M.upsert({ key: 'k', a: 99 }, { on: ['key'], update: {} });
    assert.equal(again.id, first.id);
    assert.equal(again.a, 1);
    assert.equal(M.count(), 1);
    db2.close();
  });

  test('upserts by primary key when on is omitted', () => {
    const created = User.create({ name: 'a' });
    const row = User.upsert(invalid({ id: created.id, name: 'renamed' }));
    assert.equal(row.id, created.id);
    assert.equal(row.name, 'renamed');
    assert.equal(User.count(), 1);
  });

  test('rejects a unique target without a unique constraint', () => {
    // 没有唯一索引时 SQLite 直接拒绝：调用方必须自己保证 on 上有唯一约束
    assert.throws(() => User.upsert({ name: 'a' }, { on: ['name'] }), SqlModelError);
    assert.equal(User.count(), 0);
  });
  test('rejects invalid input', () => {
    assert.throws(() => User.upsert(invalid({ unknownField: 1 })), ValidationError);
    assert.throws(() => User.upsert(invalid({ age: 'x' })), ValidationError);
    assert.throws(() => User.upsert({ name: 'a' }, invalid({ on: [] })), ValidationError);
    assert.throws(() => User.upsert({ name: 'a' }, invalid({ on: ['unknown'] })), ValidationError);
    assert.throws(() => User.upsert({ name: 'a' }, invalid({ on: ['name', 'name'] })), ValidationError);
    assert.throws(() => User.upsert({ name: 'a' }, invalid({ update: { unknownField: 1 } })), ValidationError);
  });

  test('upsertMany inserts and updates in one transaction', () => {
    const db2 = new Database(':memory:');
    const M = db2.model('M', { tableName: 'm', fields: { key: 'TEXT', value: 'INTEGER' } });
    db2.exec('CREATE UNIQUE INDEX m_key ON m (key)');
    assert.equal(M.upsertMany([{ key: 'a', value: 1 }, { key: 'b', value: 2 }], { on: ['key'] }), 2);
    assert.equal(M.upsertMany([{ key: 'a', value: 10 }, { key: 'c', value: 3 }], { on: ['key'] }), 2);
    assert.equal(M.count(), 3);
    assert.equal(M.findMany({ key: 'a' })[0]!.value, 10);
    db2.close();
  });
});

describe('constraint errors', () => {
  test('distinguishes primary key and unique conflicts', () => {
    const db2 = new Database(':memory:');
    const M = db2.model('M', { tableName: 'm', fields: { key: 'TEXT', value: 'INTEGER' } });
    db2.exec('CREATE UNIQUE INDEX m_key ON m (key)');
    const row = M.create({ key: 'a', value: 1 });

    // 主键冲突（errcode 1555）：create 不接受 id，直接用 exec 触发
    assert.throws(
      () => db2.exec(`INSERT INTO m (id, key) VALUES (${row.id}, 'b')`),
      UniqueConstraintError,
    );
    // 唯一索引冲突（errcode 2067）
    assert.throws(() => M.create({ key: 'a', value: 2 }), UniqueConstraintError);
    // 唯一约束错误也是 ConstraintError 与 SqlModelError，可统一捕获
    assert.throws(() => M.create({ key: 'a', value: 2 }), ConstraintError);
    assert.throws(() => M.create({ key: 'a', value: 2 }), SqlModelError);

    const error = (() => {
      try {
        M.create({ key: 'a', value: 2 });
      } catch (e) {
        return e as UniqueConstraintError;
      }
      return undefined;
    })();
    assert.equal(error?.name, 'UniqueConstraintError');
    assert.equal(error?.errcode, 2067);
    // 错误消息不含表名 / 列名，不泄漏 schema
    assert.equal(/m\.key|"m"/.test(error?.message ?? ''), false);
    assert.equal((error as { cause?: unknown } | undefined)?.cause instanceof Error, true);
    db2.close();
  });

  test('does not throw on a successful upsert that resolves the conflict', () => {
    const db2 = new Database(':memory:');
    const M = db2.model('M', { tableName: 'm', fields: { key: 'TEXT', value: 'INTEGER' } });
    db2.exec('CREATE UNIQUE INDEX m_key ON m (key)');
    M.create({ key: 'a', value: 1 });
    assert.equal(M.upsert({ key: 'a', value: 9 }, { on: ['key'] }).value, 9);
    // DO NOTHING 路径同样不抛
    assert.equal(M.upsert({ key: 'a', value: 5 }, { on: ['key'], update: {} }).value, 9);
    db2.close();
  });

  test('maps NOT NULL, CHECK and FOREIGN KEY violations', () => {
    const db2 = new Database(':memory:');
    const M = db2.model('M', { tableName: 'm', fields: { name: 'TEXT' } });
    // 外部工具建的表带 NOT NULL 约束：模型不会写 NULL 到显式列，用 exec 直接触发
    db2.exec('CREATE TABLE strict_t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL, c INTEGER CHECK (c > 0))');
    assert.throws(() => db2.exec('INSERT INTO strict_t (v) VALUES (NULL)'), NotNullConstraintError);
    assert.throws(() => db2.exec('INSERT INTO strict_t (v, c) VALUES (\'x\', -1)'), CheckConstraintError);

    db2.exec('CREATE TABLE parent_t (id INTEGER PRIMARY KEY AUTOINCREMENT)');
    db2.exec(
      'CREATE TABLE child_t (id INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER REFERENCES parent_t(id))',
    );
    db2.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => db2.exec('INSERT INTO child_t (pid) VALUES (999)'), ForeignKeyConstraintError);

    // 约束错误都要保持 SqlModelError 的继承关系，原有的统一捕获写法不受影响
    assert.throws(() => db2.exec('INSERT INTO strict_t (v) VALUES (NULL)'), SqlModelError);
    void M;
    db2.close();
  });
});

describe('select projection', () => {
  test('returns only the requested columns', () => {
    User.create({ name: 'a', age: 20, email: 'a@x' });
    const rows = User.findMany(undefined, { select: ['id', 'name'] });
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['id', 'name']);
    assert.equal(rows[0]!.name, 'a');
  });

  test('works for findById and search', () => {
    const created = User.create({ name: '张三', age: 30 });
    const one = User.findById(created.id, { select: ['id', 'age'] });
    assert.deepEqual(Object.keys(one!).sort(), ['age', 'id']);
    assert.equal(one!.age, 30);

    const found = User.search('张', { select: ['name'] });
    assert.deepEqual(Object.keys(found[0]!), ['name']);
  });

  test('keeps conditions and ordering working with a projection', () => {
    User.create({ name: 'a', age: 20 });
    User.create({ name: 'b', age: 40 });
    User.create({ name: 'c', age: 30 });
    const rows = User.findMany({ age: { gte: 25 } }, { select: ['name'], orderBy: 'age', order: 'ASC' });
    assert.deepEqual(
      rows.map((row) => row.name),
      ['c', 'b'],
    );
  });

  test('accepts managed columns and canonicalizes their casing', () => {
    User.create({ name: 'a' });
    const rows = User.findMany(undefined, invalid({ select: ['ID', 'CREATEDAT'] }));
    assert.deepEqual(Object.keys(rows[0]!).sort(), ['createdAt', 'id']);
  });

  test('omitting select keeps returning the full row', () => {
    User.create({ name: 'a' });
    const row = User.findMany(undefined)[0]!;
    assert.deepEqual(Object.keys(row).sort(), ['age', 'createdAt', 'email', 'id', 'name', 'score', 'updatedAt']);
  });

  test('rejects invalid select', () => {
    User.create({ name: 'a' });
    assert.throws(() => User.findMany(undefined, invalid({ select: [] })), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid({ select: ['nickname'] })), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid({ select: ['id', 'id'] })), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid({ select: 'name' })), ValidationError);
    assert.throws(() => User.findById(1, invalid({ select: ['nickname'] })), ValidationError);
    assert.throws(() => User.search('a', invalid({ select: ['unknown'] })), ValidationError);
    // 字段名同样是拼接进 SQL 的，注入写法必须被拒绝
    assert.throws(
      () => User.findMany(undefined, invalid({ select: ['name FROM users; DROP TABLE users'] })),
      ValidationError,
    );
  });
});

describe('findPage cursor pagination', () => {
  const insertMany = (count: number) => {
    const rows = Array.from({ length: count }, (_, i) => ({ name: `u${i}`, age: i % 7, email: null }));
    User.createMany(rows);
  };

  /** 按游标翻完所有页，返回按页展开的 id 列表。 */
  const drain = (options: PageOptions<UserFields>) => {
    const ids: number[] = [];
    let cursor: Cursor | null = null;
    let pages = 0;
    for (;;) {
      // drain 只跑非投影场景，显式把参数类型收窄为「不带 select」的形态
      const query: PageOptions<UserFields> & { select?: never } = { ...options, after: cursor };
      const page: Page<ModelRow<UserFields>> = User.findPage(query);
      ids.push(...page.items.map((row) => row.id));
      pages += 1;
      if (!page.hasMore) break;
      cursor = page.nextCursor;
      assert.ok(pages < 1000, 'pagination did not terminate');
    }
    return { ids, pages };
  };

  test('walks the whole table without gaps or duplicates', () => {
    insertMany(53);
    for (const order of ['ASC', 'DESC'] as const) {
      const { ids } = drain({ limit: 10, order });
      assert.equal(ids.length, 53);
      assert.equal(new Set(ids).size, 53);
      const expected = User.findMany(undefined, { orderBy: 'id', order, limit: 53 }).map((row) => row.id);
      assert.deepEqual(ids, expected);
    }
  });

  test('respects orderBy on a duplicated column', () => {
    insertMany(53);
    const { ids } = drain({ orderBy: 'age', order: 'ASC', limit: 7 });
    assert.equal(ids.length, 53);
    // 与一次性查询的顺序必须完全一致（同值时按 id 打破平局）
    const expected = User.findMany(undefined, { orderBy: 'age', order: 'ASC', limit: 53 }).map((row) => row.id);
    assert.deepEqual(ids, expected);
  });

  test('includes NULL rows when ordering by a nullable column', () => {
    // 5 行有值、4 行为 NULL：行值比较 (a,b) > (x,y) 会静默丢掉整段 NULL，这里必须不丢
    User.createMany(Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, age: i + 1 })));
    User.createMany(Array.from({ length: 4 }, (_, i) => ({ name: `z${i}`, age: null })));
    assert.equal(User.count({ age: { isNull: true } }), 4);

    // 对照基准：按 (age, id) 同向排序的完整顺序，NULL 按 SQLite 语义排在最前（ASC）/ 最后（DESC）
    const expectedOrder = (order: 'ASC' | 'DESC') =>
      db
        .prepare(`SELECT id FROM users ORDER BY age ${order}, id ${order}`)
        .all()
        .map((row) => Number(row.id));

    for (const order of ['ASC', 'DESC'] as const) {
      const { ids } = drain({ orderBy: 'age', order, limit: 2 });
      assert.equal(ids.length, 9, `NULL rows must not be skipped (${order})`);
      assert.deepEqual(ids, expectedOrder(order), `page order must match a full scan (${order})`);
    }
  });

  test('reports hasMore and nextCursor consistently', () => {
    insertMany(20);
    const first = User.findPage({ limit: 20 });
    assert.equal(first.items.length, 20);
    assert.equal(first.hasMore, false);
    assert.equal(first.nextCursor, null);

    const smaller = User.findPage({ limit: 19 });
    assert.equal(smaller.items.length, 19);
    assert.equal(smaller.hasMore, true);
    assert.equal(smaller.nextCursor?.id, smaller.items[18]!.id);
  });

  test('defaults to 20 rows per page', () => {
    insertMany(25);
    assert.equal(User.findPage().items.length, 20);
  });

  test('supports select and keeps the cursor columns available', () => {
    insertMany(5);
    const page = User.findPage({ orderBy: 'age', order: 'ASC', limit: 2, select: ['name'] });
    // 调用方只要 name，但内部仍按 age + id 生成游标，因此这两个列会被补进结果
    assert.deepEqual(Object.keys(page.items[0]!).sort(), ['age', 'id', 'name']);
    assert.equal(page.hasMore, true);
    const next = User.findPage({ orderBy: 'age', order: 'ASC', limit: 2, select: ['name'], after: page.nextCursor });
    assert.equal(next.items.length, 2);
    // 两页之间没有重叠（select 的结果里 id 被自动补上，见上一条断言）
    const firstIds = page.items.map((row) => (row as unknown as { id: number }).id);
    const nextIds = next.items.map((row) => (row as unknown as { id: number }).id);
    assert.equal(firstIds.filter((id) => nextIds.includes(id)).length, 0);
  });

  test('stays stable when rows are inserted between pages', () => {
    insertMany(10);
    const first = User.findPage({ limit: 5, order: 'DESC' });
    // 插入更新的行（id 更大，会排在 DESC 的最前面）
    User.create({ name: 'late' });
    const second = User.findPage({ limit: 5, order: 'DESC', after: first.nextCursor });
    // OFFSET 分页在这种情况下会把已看过的行再返回一次
    const overlap = first.items.filter((a) => second.items.some((b) => a.id === b.id));
    assert.equal(overlap.length, 0);
  });

  test('rejects invalid page options', () => {
    insertMany(3);
    assert.throws(() => User.findPage(invalid({ offset: 10 })), ValidationError);
    assert.throws(() => User.findPage(invalid({ limit: 0 })), ValidationError);
    assert.throws(() => User.findPage(invalid({ orderBy: 'nickname' })), ValidationError);
    assert.throws(() => User.findPage(invalid({ order: 'asc' })), ValidationError);
    assert.throws(() => User.findPage(invalid({ after: { id: 0, value: null } })), ValidationError);
    assert.throws(() => User.findPage(invalid({ after: 'abc' })), ValidationError);
    assert.throws(() => User.findPage(invalid({ after: { id: 1, value: {} } })), ValidationError);
    assert.throws(() => User.findPage(invalid({ unknown: 1 })), ValidationError);
  });
});

describe('count by column', () => {
  test('counts non-null values of a column', () => {
    User.createMany([
      { name: 'a', email: 'a@x' },
      { name: 'b', email: null },
      { name: 'c', email: 'c@x' },
    ]);
    assert.equal(User.count(), 3);
    assert.equal(User.count(undefined, { column: 'email' }), 2);
    // 与 isNull 条件互补
    assert.equal(User.count({ email: { isNull: true } }), 1);
    assert.equal(User.count(undefined, { column: 'email' }) + User.count({ email: { isNull: true } }), 3);
  });

  test('combines with where and keyword', () => {
    User.createMany([
      { name: 'alpha', age: 10, email: 'a@x' },
      { name: 'alpine', age: 20, email: null },
      { name: 'beta', age: 30, email: 'b@x' },
    ]);
    assert.equal(User.count(undefined, { column: 'email', keyword: 'al' }), 1);
    assert.equal(User.count({ age: { gte: 20 } }, { column: 'email' }), 1);
  });

  test('accepts managed columns', () => {
    User.create({ name: 'a' });
    assert.equal(User.count(undefined, { column: 'id' }), 1);
    assert.equal(User.count(undefined, { column: 'createdAt' }), 1);
  });

  test('rejects an unknown column', () => {
    assert.throws(() => User.count(undefined, invalid({ column: 'nickname' })), ValidationError);
    assert.throws(() => User.count(undefined, invalid({ column: 123 })), ValidationError);
    assert.throws(
      () => User.count(undefined, invalid({ column: 'id; DROP TABLE users' })),
      ValidationError,
    );
  });
});

describe('where on managed columns', () => {
  test('matches rows by id', () => {
    const a = User.create({ name: 'a', age: 1 });
    const b = User.create({ name: 'b', age: 2 });
    const c = User.create({ name: 'c', age: 3 });

    assert.deepEqual(
      User.findMany({ id: a.id }).map((row) => row.name),
      ['a'],
    );
    assert.deepEqual(
      User.findMany({ id: { in: [a.id, c.id] } }, { orderBy: 'id', order: 'ASC' }).map((row) => row.name),
      ['a', 'c'],
    );
    assert.equal(User.count({ id: { in: [a.id, b.id] } }), 2);
    assert.equal(User.exists({ id: b.id }), true);
    assert.equal(User.exists({ id: 999 }), false);
    assert.equal(User.findOne({ id: 999 }), undefined);
  });

  test('rejects ids that are not positive safe integers', () => {
    assert.throws(() => User.findMany(invalid({ id: 0 })), ValidationError);
    assert.throws(() => User.findMany(invalid({ id: 1.5 })), ValidationError);
    assert.throws(() => User.findMany(invalid({ id: '1' })), ValidationError);
    assert.throws(() => User.findMany(invalid({ id: { in: [null] } })), ValidationError);
    assert.throws(() => User.findMany(invalid({ id: { between: ['1', '2'] } })), ValidationError);
  });

  test('filters by timestamp range', () => {
    User.create({ name: 'a' });
    const past = '2000-01-01T00:00:00.000Z';
    const future = '2100-01-01T00:00:00.000Z';

    assert.equal(User.count({ createdAt: { gte: past } }), 1);
    assert.equal(User.count({ createdAt: { gte: future } }), 0);
    assert.equal(User.count({ createdAt: { between: [past, future] } }), 1);
    assert.equal(User.count({ createdAt: { lt: past } }), 0);
    // 时间戳是 TEXT 列，非字符串一律拒绝
    assert.throws(() => User.findMany(invalid({ createdAt: 0 })), ValidationError);
    assert.throws(() => User.count(invalid({ updatedAt: { gte: true } })), ValidationError);
  });

  test('supports isNull on manually created rows', () => {
    db.exec(`CREATE TABLE legacy ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT) STRICT`);
    const Legacy = db.model('Legacy', { tableName: 'legacy', fields: { name: 'TEXT' } });
    Legacy.create({ name: 'x' });

    // 新建的行总是写入时间戳，因此这里只校验可以按 NULL 语义查询而不会报错
    assert.equal(Legacy.count({ createdAt: { isNull: true } }), 0);
    assert.equal(Legacy.count({ createdAt: { isNull: false } }), 1);
  });
});

describe('findOne', () => {
  test('returns the newest row by default', () => {
    User.create({ name: 'a', age: 10 });
    const newest = User.create({ name: 'b', age: 20 });
    assert.equal(User.findOne()?.id, newest.id);
  });

  test('respects where and order', () => {
    User.createMany([
      { name: 'a', age: 10 },
      { name: 'b', age: 20 },
      { name: 'c', age: 20 },
    ]);
    assert.equal(User.findOne({ age: 20 })?.name, 'c');
    assert.equal(User.findOne({ age: 20 }, { order: 'ASC' })?.name, 'b');
    assert.equal(User.findOne({ age: 999 }), undefined);
  });

  test('supports projection like findMany', () => {
    User.create({ name: 'a', age: 10, email: 'a@x' });
    const row = User.findOne({ name: 'a' }, { select: ['id', 'name'] });
    assert.deepEqual(row, { id: row!.id, name: 'a' });
    assert.deepEqual(Object.keys(row!).sort(), ['id', 'name']);
  });

  test('rejects limit and offset', () => {
    assert.throws(() => User.findOne({}, invalid({ limit: 2 })), ValidationError);
    assert.throws(() => User.findOne({}, invalid({ offset: 2 })), ValidationError);
    assert.throws(() => User.findOne({}, invalid({ limt: 2 })), ValidationError);
    // limit/offset 被显式拒绝，避免「以为能取第 2 条」的误解
    assert.throws(
      () => User.findOne({}, invalid({ limit: 2 })),
      (error: Error) => error instanceof ValidationError && /Unknown option/.test(error.message),
    );
  });
});

describe('exists', () => {
  test('reports presence without reading rows', () => {
    assert.equal(User.exists(), false);
    User.create({ name: 'a', age: 10 });
    assert.equal(User.exists(), true);
    assert.equal(User.exists({ age: 10 }), true);
    assert.equal(User.exists({ age: 11 }), false);
    assert.equal(User.exists({ age: { gt: 5 }, name: 'a' }), true);
  });

  test('rejects invalid conditions like findMany', () => {
    assert.throws(() => User.exists(invalid({ nickname: 'x' })), ValidationError);
    assert.throws(() => User.exists({ name: null }), ValidationError);
  });

  test('agrees with count > 0', () => {
    User.createMany([
      { name: 'a', age: 10 },
      { name: 'b', age: null },
    ]);
    for (const where of [{ age: 10 }, { age: { isNull: true } }, { name: 'zzz' }, { age: { gte: 5 } }]) {
      assert.equal(User.exists(where), User.count(where) > 0);
    }
  });
});

describe('findByIds', () => {
  test('returns rows in the order of the given ids', () => {
    const a = User.create({ name: 'a' });
    const b = User.create({ name: 'b' });
    const c = User.create({ name: 'c' });

    const rows = User.findByIds([c.id, a.id, b.id]);
    assert.deepEqual(
      rows.map((row) => row?.name),
      ['c', 'a', 'b'],
    );
  });

  test('keeps a placeholder for missing ids', () => {
    const a = User.create({ name: 'a' });
    const rows = User.findByIds([a.id, 999, a.id]);
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.name, 'a');
    assert.equal(rows[1], undefined);
    // 重复 id 同样保持位置对应
    assert.equal(rows[2]?.id, a.id);
  });

  test('returns an empty array for an empty list', () => {
    assert.deepEqual(User.findByIds([]), []);
  });

  test('handles lists longer than the IN chunk size', () => {
    const ids = User.createMany(Array.from({ length: 1200 }, (_, i) => ({ name: `u${i}` })));
    const rows = User.findByIds(ids);
    assert.equal(rows.length, 1200);
    assert.equal(rows.filter((row) => row === undefined).length, 0);
    assert.equal(rows[1199]?.name, 'u1199');
  });

  test('rejects invalid input', () => {
    assert.throws(() => User.findByIds(invalid('1')), ValidationError);
    assert.throws(() => User.findByIds(invalid([1, 0])), ValidationError);
    assert.throws(() => User.findByIds(invalid([1, '2'])), ValidationError);
    assert.throws(() => User.findByIds(invalid([1.5])), ValidationError);
  });
});

describe('deleteMany guard rails', () => {
  test('refuses to delete without a condition', () => {
    User.createMany([{ name: 'a' }, { name: 'b' }]);
    // 编译期就不允许无参调用，这里绕过类型检查验证运行期行为
    assert.throws(() => User.deleteMany(invalid(undefined)), ValidationError);
    assert.throws(() => User.deleteMany(invalid({})), ValidationError);
    // 拒绝之后数据必须完好
    assert.equal(User.count(), 2);
  });

  test('clear() removes every row', () => {
    User.createMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    assert.deepEqual(User.clear(), { changes: 3, statements: 1 });
    assert.equal(User.count(), 0);
  });

  test('clear() still honours chunkSize', () => {
    User.createMany(Array.from({ length: 10 }, (_, i) => ({ name: `u${i}` })));
    assert.deepEqual(User.clear({ chunkSize: 4 }), { changes: 10, statements: 3 });
  });

  test('explicit confirm allows an unconditional deleteMany', () => {
    User.createMany([{ name: 'a' }, { name: 'b' }]);
    assert.equal(User.deleteMany(invalid({}), { confirm: 'all' }).changes, 2);
  });

  test('rejects an invalid confirm value', () => {
    User.create({ name: 'a' });
    assert.throws(() => User.deleteMany({ name: 'a' }, invalid({ confirm: 'yes' })), ValidationError);
  });

  test('still deletes normally with a condition', () => {
    User.createMany([{ name: 'a', age: 1 }, { name: 'b', age: 2 }]);
    assert.equal(User.deleteMany({ age: 1 }).changes, 1);
    assert.equal(User.count(), 1);
  });
});
