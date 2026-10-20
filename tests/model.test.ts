import { afterEach, beforeEach, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Database, ValidationError } from '../src/index.js';
import type { Model } from '../src/index.js';

// 传入故意非法的参数时绕过编译期检查，测试运行时校验
const invalid = (value: unknown): never => value as never;

// 等待时钟前进，确保毫秒级时间戳出现可见变化
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type UserFields = {
  name: 'TEXT';
  age: 'INTEGER';
  email: 'TEXT';
  score: 'REAL';
  avatar: 'BLOB';
};

let db: Database;
let User: Model<UserFields>;

beforeEach(() => {
  db = new Database(':memory:');
  User = db.model('User', {
    tableName: 'users',
    fields: { name: 'TEXT', age: 'INTEGER', email: 'TEXT', score: 'REAL', avatar: 'BLOB' },
  });
});

afterEach(() => {
  db.close();
});

describe('create', () => {
  test('inserts a record and returns the full row with an auto-increment id', () => {
    const user = User.create({ name: '张三', age: 25, email: 'z@example.com' });
    assert.equal(user.id, 1);
    assert.equal(user.name, '张三');
    assert.equal(user.age, 25);
    assert.equal(user.email, 'z@example.com');
    // 未提供的字段存储为 NULL
    assert.equal(user.score, null);
    assert.equal(user.avatar, null);

    const second = User.create({ name: '李四', age: 30, email: 'l@example.com' });
    assert.equal(second.id, 2);
  });

  test('returns a plain object with exactly the expected fields', () => {
    const user = User.create({ name: '张三' });
    assert.equal(Object.getPrototypeOf(user), Object.prototype);
    assert.deepEqual(
      Object.keys(user).sort(),
      ['age', 'avatar', 'createdAt', 'email', 'id', 'name', 'score', 'updatedAt'],
    );
  });

  test('stores explicit null values', () => {
    const user = User.create({ name: '张三', email: null });
    assert.equal(user.email, null);
  });

  test('supports BLOB and REAL round-trips', () => {
    const blob = new Uint8Array([0, 1, 128, 255]);
    const user = User.create({ name: 'blob用户', score: 3.14159, avatar: blob });
    const found = User.findById(user.id);
    assert.deepEqual(found?.avatar, blob);
    assert.equal(found?.score, 3.14159);
  });

  test('stores the maximum safe integer', () => {
    const user = User.create({ name: 'max', age: Number.MAX_SAFE_INTEGER });
    assert.equal(User.findById(user.id)?.age, Number.MAX_SAFE_INTEGER);
  });

  test('sets createdAt/updatedAt automatically on create', () => {
    const user = User.create({ name: '张三', age: 25 });
    const { createdAt, updatedAt } = user;
    assert.ok(typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)));
    assert.ok(typeof updatedAt === 'string' && !Number.isNaN(Date.parse(updatedAt)));
    // 创建时刻两者相同
    assert.equal(createdAt, updatedAt);
  });

  test('rejects managed timestamp fields in create/update', () => {
    const user = User.create({ name: '张三' });
    const ts = '2020-01-01T00:00:00.000Z';
    assert.throws(() => User.create(invalid({ createdAt: ts })), ValidationError);
    assert.throws(() => User.create(invalid({ updatedAt: ts })), ValidationError);
    assert.throws(() => User.update(user.id, invalid({ createdAt: ts })), ValidationError);
    assert.throws(() => User.update(user.id, invalid({ updatedAt: ts })), ValidationError);
  });

  test('allows managed timestamps as query conditions but only with string values', () => {
    User.create({ name: '张三' });
    // 时间戳只读，但按时间范围查询是常见需求，因此允许作为条件
    assert.equal(User.findMany(invalid({ createdAt: { gte: '2000-01-01T00:00:00.000Z' } })).length, 1);
    assert.equal(User.count(invalid({ updatedAt: { lte: '2999-01-01T00:00:00.000Z' } })), 1);
    assert.throws(() => User.findMany(invalid({ createdAt: 1 })), ValidationError);
    assert.throws(() => User.count(invalid({ updatedAt: { gte: 123 } })), ValidationError);
  });

  test('rejects an empty data object', () => {
    assert.throws(() => User.create({}), ValidationError);
    assert.throws(() => User.create({ age: undefined }), ValidationError);
  });

  test('rejects unknown fields', () => {
    assert.throws(() => User.create(invalid({ nickname: 'x' })), ValidationError);
    assert.throws(() => User.create(invalid({ id: 1, name: 'x' })), ValidationError);
  });

  test('rejects values that do not match the field type', () => {
    assert.throws(() => User.create(invalid({ name: 123 })), ValidationError);
    assert.throws(() => User.create(invalid({ age: '25' })), ValidationError);
    assert.throws(() => User.create({ age: 1.5 }), ValidationError);
    assert.throws(() => User.create({ age: Number.MAX_SAFE_INTEGER + 1 }), ValidationError);
    assert.throws(() => User.create({ age: NaN }), ValidationError);
    assert.throws(() => User.create(invalid({ score: '1.5' })), ValidationError);
    assert.throws(() => User.create({ score: Infinity }), ValidationError);
    assert.throws(() => User.create(invalid({ avatar: 'binary' })), ValidationError);
  });

  test('safely binds special characters without SQL injection', () => {
    const evil = `张三'); DROP TABLE users; -- "双引号" '单引号' \n 换行`;
    const user = User.create({ name: evil, email: `a'b"c@example.com` });

    assert.equal(User.findById(user.id)?.name, evil);
    assert.equal(User.findMany({ name: evil }).length, 1);
    assert.equal(User.findMany({ email: `a'b"c@example.com` }).length, 1);

    // 表仍然完好，可以继续写入
    const next = User.create({ name: 'after-attack' });
    assert.equal(next.id, user.id + 1);
  });
});

describe('findById', () => {
  test('returns the row for an existing id', () => {
    const created = User.create({ name: '张三', age: 25 });
    const found = User.findById(created.id);
    assert.deepEqual(found, created);
  });

  test('returns undefined for a missing id', () => {
    User.create({ name: '张三' });
    assert.equal(User.findById(999), undefined);
  });

  test('rejects invalid ids', () => {
    for (const id of [1.5, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => User.findById(id), ValidationError, `id ${id} should be rejected`);
    }
    for (const id of ['1', null, undefined, {}, []]) {
      assert.throws(() => User.findById(invalid(id)), ValidationError, `id ${String(id)} should be rejected`);
    }
  });
});

describe('findMany', () => {
  test('returns all rows ordered by id DESC by default', () => {
    User.create({ name: 'a' });
    User.create({ name: 'b' });
    User.create({ name: 'c' });
    assert.deepEqual(User.findMany().map((u) => u.name), ['c', 'b', 'a']);
  });

  test('returns an empty array for no matches', () => {
    assert.deepEqual(User.findMany(), []);
    User.create({ name: '张三', age: 25 });
    assert.deepEqual(User.findMany({ age: 99 }), []);
  });

  test('filters by a single field', () => {
    User.create({ name: '张三', age: 25 });
    User.create({ name: '李四', age: 30 });
    const users = User.findMany({ age: 25 });
    assert.equal(users.length, 1);
    assert.equal(users[0].name, '张三');
  });

  test('combines multiple fields with AND', () => {
    User.create({ name: '张三', age: 25, email: 'z@example.com' });
    User.create({ name: '张三', age: 30, email: 'z@example.com' });
    User.create({ name: '李四', age: 25, email: 'l@example.com' });

    assert.equal(User.findMany({ name: '张三', age: 30 }).length, 1);
    assert.equal(User.findMany({ name: '张三', age: 30, email: 'z@example.com' }).length, 1);
    assert.equal(User.findMany({ name: '张三', age: 25, email: 'l@example.com' }).length, 0);
  });

  test('treats an empty condition object as no condition', () => {
    User.create({ name: 'a' });
    User.create({ name: 'b' });
    assert.equal(User.findMany({}).length, 2);
  });

  test('rejects invalid conditions', () => {
    assert.throws(() => User.findMany(invalid({ nickname: 'x' })), ValidationError);
    // id 是托管列，可以查询，但类型必须匹配（INTEGER）
    assert.throws(() => User.findMany(invalid({ id: 'one' })), ValidationError);
    assert.throws(() => User.findMany({ name: null }), ValidationError);
    assert.throws(() => User.findMany(invalid({ age: '25' })), ValidationError);
  });
});

describe('update', () => {
  test('updates only the provided fields and returns the updated row', () => {
    const user = User.create({ name: '张三', age: 25, email: 'z@example.com' });
    const returned = User.update(user.id, { age: 26 });
    assert.equal(returned?.age, 26);
    // 未传入的字段保持原值，返回值与回读结果一致
    assert.deepEqual(returned, User.findById(user.id));

    const updated = User.findById(user.id);
    assert.equal(updated?.age, 26);
    assert.equal(updated?.name, '张三');
    assert.equal(updated?.email, 'z@example.com');
  });

  test('can set a field to null', () => {
    const user = User.create({ name: '张三', age: 25 });
    assert.equal(User.update(user.id, { age: null })?.age, null);
    assert.equal(User.findById(user.id)?.age, null);
  });

  test('refreshes updatedAt automatically but keeps createdAt', async () => {
    const user = User.create({ name: '张三', age: 25 });
    await sleep(5);
    const returned = User.update(user.id, { age: 26 });
    assert.ok(returned !== undefined);

    const updated = User.findById(user.id);
    // 创建时间永不变化
    assert.equal(updated?.createdAt, user.createdAt);
    assert.equal(returned.createdAt, user.createdAt);
    // 修改时间已刷新
    const before = user.updatedAt;
    const after = updated?.updatedAt;
    assert.ok(typeof before === 'string' && typeof after === 'string');
    assert.ok(Date.parse(after) > Date.parse(before));
    // 返回值里的 updatedAt 就是刷新后的值
    assert.equal(returned.updatedAt, after);
  });

  test('returns undefined for a missing record', () => {
    User.create({ name: '张三' });
    assert.equal(User.update(999, { name: '李四' }), undefined);
    assert.equal(User.findById(999), undefined);
  });
});

describe('delete', () => {
  test('deletes an existing record and returns the removed row', () => {
    const user = User.create({ name: '张三', age: 25 });
    const removed = User.delete(user.id);
    // 返回删除前的快照，可用于审计或回收站
    assert.deepEqual(removed, user);
    assert.equal(User.findById(user.id), undefined);
    assert.equal(User.count(), 0);
  });

  test('returns undefined when the record does not exist', () => {
    User.create({ name: '张三' });
    assert.equal(User.delete(999), undefined);
  });

  test('deleting twice returns undefined the second time', () => {
    const user = User.create({ name: '张三' });
    assert.ok(User.delete(user.id) !== undefined);
    assert.equal(User.delete(user.id), undefined);
  });

  test('is atomic when called inside a transaction that rolls back', () => {
    const user = User.create({ name: '张三' });
    assert.throws(() =>
      db.transaction(() => {
        assert.ok(User.delete(user.id) !== undefined);
        throw new Error('boom');
      }),
    );
    assert.ok(User.findById(user.id) !== undefined);
  });

  test('rejects invalid ids', () => {
    assert.throws(() => User.delete(0), ValidationError);
    assert.throws(() => User.delete(1.5), ValidationError);
    assert.throws(() => User.delete(invalid('1')), ValidationError);
  });
});

describe('count', () => {
  test('counts all rows', () => {
    User.create({ name: 'a' });
    User.create({ name: 'b' });
    User.create({ name: 'c' });
    assert.equal(User.count(), 3);
  });

  test('counts zero rows on an empty table', () => {
    assert.equal(User.count(), 0);
  });

  test('counts with the same equality filters as findMany', () => {
    User.create({ name: '张三', age: 25 });
    User.create({ name: '张三', age: 30 });
    User.create({ name: '李四', age: 25 });

    assert.equal(User.count({ age: 25 }), 2);
    assert.equal(User.count({ name: '张三', age: 30 }), 1);
    assert.equal(User.count({ name: '不存在' }), 0);
    assert.equal(User.count({ age: 25 }), User.findMany({ age: 25 }).length);
  });

  test('rejects invalid conditions', () => {
    assert.throws(() => User.count(invalid({ nickname: 'x' })), ValidationError);
    assert.throws(() => User.count({ name: null }), ValidationError);
  });
});

describe('findMany 排序与分页', () => {
  test('supports custom orderBy and order direction', () => {
    User.create({ name: 'a', age: 30 });
    User.create({ name: 'b', age: 20 });
    User.create({ name: 'c', age: 25 });

    assert.deepEqual(
      User.findMany(undefined, { orderBy: 'age', order: 'ASC' }).map((u) => u.age),
      [20, 25, 30],
    );
    assert.deepEqual(
      User.findMany(undefined, { orderBy: 'age', order: 'DESC' }).map((u) => u.age),
      [30, 25, 20],
    );
    // TEXT 字段按字典序
    assert.deepEqual(
      User.findMany(undefined, { orderBy: 'name', order: 'ASC' }).map((u) => u.name),
      ['a', 'b', 'c'],
    );
  });

  test('defaults to DESC when orderBy is given without order', () => {
    User.create({ name: 'a', age: 30 });
    User.create({ name: 'b', age: 20 });
    User.create({ name: 'c', age: 25 });
    assert.deepEqual(User.findMany(undefined, { orderBy: 'age' }).map((u) => u.age), [30, 25, 20]);
  });

  test('paginates with limit and offset', () => {
    for (let i = 1; i <= 5; i++) User.create({ name: `u${i}`, age: i });

    assert.deepEqual(User.findMany(undefined, { limit: 2 }).map((u) => u.id), [5, 4]);
    assert.deepEqual(User.findMany(undefined, { limit: 2, offset: 2 }).map((u) => u.id), [3, 2]);
    assert.deepEqual(User.findMany(undefined, { limit: 2, offset: 4 }).map((u) => u.id), [1]);
    // offset 超出总数返回空数组
    assert.deepEqual(User.findMany(undefined, { limit: 2, offset: 6 }), []);
    // limit 大于总数返回全部
    assert.deepEqual(User.findMany(undefined, { limit: 10 }).map((u) => u.id), [5, 4, 3, 2, 1]);
    // offset 0 合法
    assert.deepEqual(User.findMany(undefined, { limit: 5, offset: 0 }).length, 5);
  });

  test('walks pages together with count()', () => {
    for (let i = 1; i <= 5; i++) User.create({ name: `u${i}`, age: i });

    const pageSize = 2;
    const total = User.count();
    const totalPages = Math.ceil(total / pageSize);
    const pages: number[][] = [];
    for (let page = 1; page <= totalPages; page++) {
      pages.push(
        User.findMany(undefined, { limit: pageSize, offset: (page - 1) * pageSize }).map((u) => u.id),
      );
    }
    assert.equal(total, 5);
    assert.equal(totalPages, 3);
    assert.deepEqual(pages, [[5, 4], [3, 2], [1]]);
    assert.deepEqual(User.findMany(undefined, { limit: pageSize, offset: totalPages * pageSize }), []);
  });

  test('combines where conditions with ordering and pagination', () => {
    User.create({ name: 'a', age: 25 });
    User.create({ name: 'b', age: 30 });
    User.create({ name: 'c', age: 25 });
    User.create({ name: 'd', age: 40 });

    const result = User.findMany({ age: 25 }, { orderBy: 'name', order: 'ASC', limit: 1, offset: 1 });
    assert.deepEqual(result.map((u) => u.name), ['c']);
    assert.equal(User.count({ age: 25 }), 2);
  });

  test('rejects invalid orderBy', () => {
    User.create({ name: 'a' });
    assert.throws(() => User.findMany(undefined, invalid({ orderBy: 'nickname' })), ValidationError);
    assert.throws(
      () => User.findMany(undefined, invalid({ orderBy: 'name; DROP TABLE users' })),
      ValidationError,
    );
    assert.throws(() => User.findMany(undefined, invalid({ orderBy: 123 })), ValidationError);
  });

  test('allows managed columns as orderBy', () => {
    User.create({ name: 'a' });
    User.create({ name: 'b' });
    const asc = User.findMany(undefined, { orderBy: 'id', order: 'ASC' }).map((row) => row.id);
    assert.deepEqual(asc, [1, 2]);
    // 不传 orderBy 时默认已按 id DESC，显式传 id 应得到同样结果
    const desc = User.findMany(undefined, { orderBy: 'id' }).map((row) => row.id);
    assert.deepEqual(desc, [2, 1]);
    // createdAt 可以作为排序字段（同一毫秒内写入的两行取值相同，因此只校验集合与 id 一致）
    const byCreated = User.findMany(undefined, { orderBy: 'createdAt' }).map((row) => row.id);
    assert.deepEqual([...byCreated].sort(), [1, 2]);
    const byUpdated = User.findMany(undefined, { orderBy: 'updatedAt', order: 'ASC' }).map((row) => row.id);
    assert.deepEqual([...byUpdated].sort(), [1, 2]);
  });

  test('rejects invalid order values', () => {
    User.create({ name: 'a' });
    assert.throws(() => User.findMany(undefined, invalid({ order: 'asc' })), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid({ order: 'RANDOM()' })), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid({ order: 1 })), ValidationError);
  });

  test('rejects invalid limit and offset', () => {
    User.create({ name: 'a' });
    for (const limit of [0, -1, 1.5, NaN, Infinity, '10']) {
      assert.throws(
        () => User.findMany(undefined, invalid({ limit })),
        ValidationError,
        `limit ${String(limit)} should be rejected`,
      );
    }
    for (const offset of [-1, 1.5, NaN, '5']) {
      assert.throws(
        () => User.findMany(undefined, invalid({ limit: 5, offset })),
        ValidationError,
        `offset ${String(offset)} should be rejected`,
      );
    }
  });

  test('offset requires limit', () => {
    User.create({ name: 'a' });
    assert.throws(() => User.findMany(undefined, invalid({ offset: 2 })), ValidationError);
  });

  test('rejects unknown option keys and non-object options', () => {
    User.create({ name: 'a' });
    // 未知选项键（如 limit 拼写错误）不能被静默忽略，否则会意外加载全表
    assert.throws(() => User.findMany(undefined, invalid({ limt: 5 })), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid(null)), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid(5)), ValidationError);
    assert.throws(() => User.findMany(undefined, invalid([])), ValidationError);
    // 空对象与显式 undefined 等同不传
    assert.equal(User.findMany(undefined, {}).length, 1);
    assert.equal(User.findMany(undefined, undefined).length, 1);
  });
});

describe('错误信息不泄露 schema 标识符', () => {
  test('CRUD 校验错误不回显模型名 / 表名 / 字段名', () => {
    const db2 = new Database(':memory:');
    const secret = db2.model('InternalPayroll', {
      tableName: 'employee_salaries',
      fields: { fullName: 'TEXT', salaryCents: 'INTEGER' },
    });

    const cases: Array<() => unknown> = [
      () => secret.create(invalid({ unknownColumn: 'x' })),
      () => secret.update(1, invalid({ unknownColumn: 'x' })),
      () => secret.findMany(invalid({ unknownColumn: 'x' })),
      () => secret.findMany(invalid({ salaryCents: '0' })),
      () => secret.deleteField('fullName'),
      () => secret.create(invalid({ fullName: 123 })),
      () => secret.create({}),
      () => secret.findMany(undefined, invalid({ orderBy: 'unknownColumn' })),
    ];

    for (const run of cases) {
      assert.throws(run, (error: unknown) => {
        const message = (error as Error).message;
        for (const identifier of ['InternalPayroll', 'employee_salaries', 'fullName', 'salaryCents', 'unknownColumn']) {
          assert.ok(
            !message.includes(identifier),
            `message must not contain "${identifier}", got: ${message}`,
          );
        }
        return true;
      });
    }
    db2.close();
  });

  test('注入尝试不会被回显到错误消息里', () => {
    const db2 = new Database(':memory:');
    const User = db2.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    const payload = 'x"; DROP TABLE users; --';

    assert.throws(
      () => db2.model('M2', { tableName: payload, fields: { name: 'TEXT' } }),
      (error: unknown) => {
        assert.ok(!(error as Error).message.includes('DROP TABLE'));
        return true;
      },
    );
    assert.throws(
      () => User.deleteField(payload),
      (error: unknown) => {
        assert.ok(!(error as Error).message.includes('DROP TABLE'));
        return true;
      },
    );
    db2.close();
  });
});

describe('search 关键字搜索', () => {
  test('matches substrings case-insensitively across default TEXT fields', () => {
    User.create({ name: 'Zhang San', email: 'zhang@example.com' });
    User.create({ name: '李四', email: 'lisi@example.com' });
    User.create({ name: '王五', email: 'wang@example.com' });

    // 默认搜索全部 TEXT 字段（name、email），ASCII 大小写不敏感
    assert.equal(User.search('zhang').length, 1);
    assert.equal(User.search('example.com').length, 3);
    assert.equal(User.search('李').length, 1);
    assert.equal(User.search('不存在').length, 0);
  });

  test('only TEXT fields participate by default', () => {
    User.create({ name: 'abc', age: 25, score: 1.5 });
    assert.equal(User.search('25').length, 0);   // INTEGER 不参与
    assert.equal(User.search('1.5').length, 0);  // REAL 不参与
    assert.equal(User.search('abc').length, 1);
  });

  test('restricts search to the given fields', () => {
    User.create({ name: 'Zhang San', email: 'zhang@example.com' });
    assert.equal(User.search('zhang', { fields: ['name'] }).length, 1);
    // 只搜 name：email 中的 example.com 不再命中
    assert.equal(User.search('example.com', { fields: ['name'] }).length, 0);
  });

  test('supports ordering and pagination', () => {
    User.create({ name: 'apple', email: 'a@example.com' });
    User.create({ name: 'banana', email: 'b@example.com' });
    User.create({ name: 'cherry', email: 'c@example.com' });

    const page1 = User.search('example', { orderBy: 'name', order: 'ASC', limit: 2 });
    assert.deepEqual(page1.map((u) => u.name), ['apple', 'banana']);
    const page2 = User.search('example', { orderBy: 'name', order: 'ASC', limit: 2, offset: 2 });
    assert.deepEqual(page2.map((u) => u.name), ['cherry']);
    // 不传 options 时默认按 id 降序
    assert.deepEqual(User.search('example').map((u) => u.name), ['cherry', 'banana', 'apple']);
  });

  test('passes LIKE wildcards through as-is', () => {
    User.create({ name: '张三' });
    User.create({ name: '张四' });
    User.create({ name: '李三' });
    // _ 匹配单个字符，原样生效
    assert.deepEqual(
      User.search('张_', { fields: ['name'] }).map((u) => u.name).sort(),
      ['张三', '张四'],
    );
  });

  test('binds keyword safely (quotes and injection attempts)', () => {
    User.create({ name: `O'Brien "q"; DROP TABLE users; --` });
    assert.equal(User.search(`O'Brien "q"`).length, 1);
    assert.equal(User.search(`'; DROP TABLE users; --`).length, 0);
    // 表仍完好
    assert.equal(User.count(), 1);
  });

  test('count supports keyword for pagination totals', () => {
    for (let i = 1; i <= 5; i++) User.create({ name: `user${i}`, email: `u${i}@example.com` });
    assert.equal(User.count(undefined, { keyword: 'user' }), 5);
    assert.equal(User.count(undefined, { keyword: 'user', fields: ['email'] }), 0);
    // where 与 keyword 组合（AND 关系）
    User.create({ name: 'user6', email: 'special@example.com' });
    assert.equal(User.count({ email: 'special@example.com' }, { keyword: 'user' }), 1);

    // 分页遍历：search 结果数与 keyword count 一致
    const total = User.count(undefined, { keyword: 'user' });
    const pageSize = 2;
    const pages = Math.ceil(total / pageSize);
    let collected = 0;
    for (let page = 1; page <= pages; page++) {
      collected += User.search('user', { limit: pageSize, offset: (page - 1) * pageSize }).length;
    }
    assert.equal(collected, total);
  });

  test('rejects empty or non-string keywords', () => {
    for (const kw of ['', 123, null, undefined, {}]) {
      assert.throws(
        () => User.search(invalid(kw)),
        ValidationError,
        `keyword ${String(kw)} should be rejected`,
      );
    }
    assert.throws(() => User.count(undefined, invalid({ keyword: '' })), ValidationError);
  });

  test('rejects invalid fields', () => {
    User.create({ name: 'a' });
    assert.throws(() => User.search('a', invalid({ fields: 'name' })), ValidationError);
    assert.throws(() => User.search('a', invalid({ fields: ['nickname'] })), ValidationError);
    assert.throws(() => User.search('a', invalid({ fields: ['age'] })), ValidationError);
    assert.throws(() => User.search('a', invalid({ fields: ['name', 'name'] })), ValidationError);
    assert.throws(() => User.search('a', invalid({ fields: [] })), ValidationError);
    assert.throws(() => User.search('a', invalid({ fields: [123] })), ValidationError);
    assert.throws(() => User.count(undefined, invalid({ fields: ['age'] })), ValidationError);
  });

  test('rejects unknown option keys', () => {
    User.create({ name: 'a' });
    assert.throws(() => User.search('a', invalid({ field: ['name'] })), ValidationError);
    assert.throws(() => User.search('a', invalid({ limt: 5 })), ValidationError);
    assert.throws(() => User.count(undefined, invalid({ keyword: 'a', extra: 1 })), ValidationError);
  });

  test('model without TEXT fields cannot be searched', () => {
    const db2 = new Database(':memory:');
    const Counter = db2.model('Counter', { tableName: 'counters', fields: { value: 'INTEGER' } });
    assert.throws(() => Counter.search('x'), ValidationError);
    assert.throws(() => Counter.count(undefined, { keyword: 'x' }), ValidationError);
    db2.close();
  });
});

describe('instance handles', () => {
  test('methods keep working when destructured', () => {
    // 方法定义在原型上并依赖 this；构造函数里绑定后，解构调用不会丢 this
    const { create, findById, count } = User;
    const row = create({ name: '张三', age: 25 });
    assert.equal(row.name, '张三');
    assert.equal(findById(row.id)?.age, 25);
    assert.equal(count(), 1);
  });

  test('methods keep working as callbacks', () => {
    // 单签名的 exists 可以直接作为回调传递（多签名的 findById 交给 TS 重载解析不合适）
    const { exists } = User;
    User.create({ name: 'a' });
    User.create({ name: 'b' });
    assert.deepEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }].map(exists), [true, true, false]);
  });

  test('bound methods do not change the enumerable surface', () => {
    // 绑定产生的是不可枚举的自有属性：Object.keys / JSON.stringify 看不到方法，
    // 与绑定前保持一致（否则 console.log 与序列化结果会莫名其妙变长）
    const own = User as unknown as Record<string, unknown>;
    const methodKeys = Object.keys(User).filter((key) => typeof own[key] === 'function');
    assert.deepEqual(methodKeys, []);
    assert.equal(Object.prototype.propertyIsEnumerable.call(User, 'create'), false);
    assert.equal(Object.prototype.propertyIsEnumerable.call(User, 'findMany'), false);
  });

  test('exposes the underlying connection', () => {
    User.create({ name: '张三', age: 25 });
    // 需要 JOIN 或本库未覆盖的写法时，可直接复用同一条连接
    const rows = User.db.prepare('SELECT "name" FROM "users" WHERE "age" = ?').all(25) as Array<{
      name: string;
    }>;
    assert.deepEqual(rows.map((row) => row.name), ['张三']);
    assert.equal(User.db, db);
  });

  test('exposes a frozen copy of the declared fields', () => {
    const fields = {
      name: 'TEXT',
      age: 'INTEGER',
      email: 'TEXT',
      score: 'REAL',
      avatar: 'BLOB',
    } as const;
    const Fresh = db.model('Fresh', { tableName: 'fresh', fields });
    assert.deepEqual({ ...Fresh.fields }, fields);
    // 冻结的是拷贝：改不动模型声明，也改不动调用方自己传进去的对象
    assert.equal(Object.isFrozen(Fresh.fields), true);
    assert.throws(() => {
      (Fresh.fields as Record<string, string>).name = 'INTEGER';
    }, TypeError);
    assert.equal(fields.name, 'TEXT');
  });

  test('rejects managed columns in the declared fields map', () => {
    assert.throws(
      () => db.model('Bad', { tableName: 'bad', fields: { name: 'TEXT', id: 'INTEGER' } }),
      Error,
    );
  });
});
