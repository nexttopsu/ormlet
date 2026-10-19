import { afterEach, beforeEach, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  Database,
  DatabaseClosedError,
  SqlModelError,
  TransactionError,
  ValidationError,
} from '../src/index.js';
import type { Model } from '../src/index.js';

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
