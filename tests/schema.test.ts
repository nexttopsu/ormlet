import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database, DatabaseClosedError, InvalidModelError, ValidationError } from '../src/index.js';

// 传入故意非法的参数时绕过编译期检查，测试运行时校验
const invalid = (value: unknown): never => value as never;

function tempFile(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlmodel-schema-'));
  return {
    file: path.join(dir, 'data.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('syncFields 字段同步', () => {
  test('注册模型时自动补齐表中缺失的字段', () => {
    const { file, cleanup } = tempFile();
    try {
      // v1：只有 name 字段
      const db1 = new Database(file);
      const V1 = db1.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
      const created = V1.create({ name: '张三' });
      db1.close();

      // v2：新增 age、email 字段，重新打开时自动补齐
      const db2 = new Database(file);
      const User = db2.model('User', {
        tableName: 'users',
        fields: { name: 'TEXT', age: 'INTEGER', email: 'TEXT' },
      });

      // 旧行的新增列为 NULL
      const old = User.findById(created.id);
      assert.equal(old?.name, '张三');
      assert.equal(old?.age, null);
      assert.equal(old?.email, null);

      // 新字段可以直接写入和查询
      const next = User.create({ name: '李四', age: 30, email: 'l@example.com' });
      assert.equal(next.age, 30);
      assert.equal(User.count({ email: 'l@example.com' }), 1);
      assert.equal(User.update(created.id, { age: 25 })?.age, 25);
      db2.close();
    } finally {
      cleanup();
    }
  });

  test('重复调用是幂等的，返回空数组', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } });
    assert.deepEqual(User.syncFields(), []);
    User.create({ name: '张三' });
    assert.deepEqual(User.syncFields(), []);
    db.close();
  });

  test('忽略表中存在但模型未声明的字段', () => {
    const { file, cleanup } = tempFile();
    try {
      const db1 = new Database(file);
      db1.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } })
        .create({ name: '张三', age: 25 });
      db1.close();

      // v2 模型移除了 age：多余的 age 列保留在表中，不受影响
      const db2 = new Database(file);
      const User = db2.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
      assert.deepEqual(User.syncFields(), []);
      const found = User.findById(1);
      assert.equal(found?.name, '张三');
      // SELECT * 会透传表中多余的列
      assert.equal((found as unknown as Record<string, unknown>).age, 25);
      assert.equal(User.count(), 1);
      db2.close();
    } finally {
      cleanup();
    }
  });

  test('另一连接删除列后，syncFields 重新补建并返回新增字段', () => {
    const { file, cleanup } = tempFile();
    try {
      const dbA = new Database(file);
      const UserA = dbA.model('User', {
        tableName: 'users',
        fields: { name: 'TEXT', age: 'INTEGER' },
      });

      const dbB = new Database(file);
      const UserB = dbB.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
      assert.equal(UserB.deleteField('age'), true);

      // A 的模型仍声明 age，手动同步时重新补建
      assert.deepEqual(UserA.syncFields(), ['age']);
      assert.deepEqual(UserA.syncFields(), []);
      assert.equal(UserA.create({ name: '张三', age: 25 }).age, 25);

      dbA.close();
      dbB.close();
    } finally {
      cleanup();
    }
  });
});

describe('deleteField 删除字段', () => {
  test('删除模型未声明的列，返回 true；再删返回 false', () => {
    const { file, cleanup } = tempFile();
    try {
      const db1 = new Database(file);
      db1.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } })
        .create({ name: '张三', age: 25 });
      db1.close();

      // v2 模型移除 age 后，age 成为可删除的多余列
      const db2 = new Database(file);
      const User = db2.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
      assert.equal(User.deleteField('age'), true);
      assert.equal(User.deleteField('age'), false);

      // 模型操作不受影响
      assert.equal(User.count(), 1);
      assert.equal(User.findById(1)?.name, '张三');
      assert.equal(User.create({ name: '李四' }).name, '李四');
      db2.close();

      // 重新声明该字段时自动补建，旧行该列为 NULL
      const db3 = new Database(file);
      const User3 = db3.model('User', {
        tableName: 'users',
        fields: { name: 'TEXT', age: 'INTEGER' },
      });
      assert.equal(User3.findById(1)?.age, null);
      db3.close();
    } finally {
      cleanup();
    }
  });

  test('拒绝删除模型声明的字段（大小写不敏感）', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } });
    assert.throws(() => User.deleteField('name'), ValidationError);
    assert.throws(() => User.deleteField('age'), ValidationError);
    // SQLite 列名大小写不敏感，不允许用大小写变体绕过保护
    assert.throws(() => User.deleteField('NAME'), ValidationError);
    assert.throws(() => User.deleteField('Age'), ValidationError);
    db.close();
  });

  test('拒绝删除主键 id；不存在的字段返回 false', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    assert.throws(() => User.deleteField('id'), ValidationError);
    assert.throws(() => User.deleteField('ID'), ValidationError);
    assert.equal(User.deleteField('ghost'), false);
    db.close();
  });

  test('拒绝删除自动管理的时间戳字段（大小写不敏感）', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    assert.throws(() => User.deleteField('createdAt'), ValidationError);
    assert.throws(() => User.deleteField('updatedAt'), ValidationError);
    assert.throws(() => User.deleteField('CreatedAt'), ValidationError);
    assert.throws(() => User.deleteField('UPDATEDAT'), ValidationError);
    db.close();
  });

  test('拒绝非法字段名', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    assert.throws(() => User.deleteField(invalid('age; DROP TABLE users')), ValidationError);
    assert.throws(() => User.deleteField(invalid('bad field')), ValidationError);
    assert.throws(() => User.deleteField(invalid('')), ValidationError);
    assert.throws(() => User.deleteField(invalid(123)), ValidationError);
    db.close();
  });
});

describe('注册安全', () => {
  test('表名被占用时注册失败，不会改动已有表结构', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    assert.throws(
      () => db.model('Account', { tableName: 'users', fields: { extra: 'TEXT' } }),
      InvalidModelError,
    );
    // 失败的注册不应把 Account 的 extra 字段加进 users 表
    assert.equal(User.deleteField('extra'), false);
    db.close();
  });

  test('关闭数据库后 syncFields / deleteField 被拒绝', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    db.close();
    assert.throws(() => User.syncFields(), DatabaseClosedError);
    assert.throws(() => User.deleteField('extra'), DatabaseClosedError);
  });
});

describe('自动时间戳字段', () => {
  test('拒绝在模型中声明保留的时间戳字段', () => {
    const db = new Database(':memory:');
    assert.throws(() => db.model('M1', { tableName: 't1', fields: { createdAt: 'TEXT' } }), InvalidModelError);
    assert.throws(() => db.model('M2', { tableName: 't2', fields: { updatedAt: 'TEXT' } }), InvalidModelError);
    // 大小写变体同样拒绝，避免与自动列冲突
    assert.throws(() => db.model('M3', { tableName: 't3', fields: { CREATEDAT: 'TEXT' } }), InvalidModelError);
    assert.throws(() => db.model('M4', { tableName: 't4', fields: { UpdatedAt: 'TEXT' } }), InvalidModelError);
    db.close();
  });

  test('为缺少时间戳列的旧表自动补齐，旧行保持 NULL', () => {
    const { file, cleanup } = tempFile();
    try {
      // 模拟旧版本库或外部工具创建的表：没有 createdAt / updatedAt 列
      const raw = new DatabaseSync(file);
      raw.exec('CREATE TABLE "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT) STRICT');
      raw.prepare('INSERT INTO "users" ("name") VALUES (?)').run('旧数据');
      raw.close();

      const db = new Database(file);
      const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });

      // 旧行的时间戳为 NULL（原始创建时间不可知）
      const old = User.findById(1);
      assert.equal(old?.name, '旧数据');
      assert.equal(old?.createdAt, null);
      assert.equal(old?.updatedAt, null);

      // 新行自动写入时间戳
      const fresh = User.create({ name: '新数据' });
      assert.ok(typeof fresh.createdAt === 'string');
      assert.ok(typeof fresh.updatedAt === 'string');

      // 旧行更新后 updatedAt 被写入，createdAt 保持 NULL
      assert.equal(User.update(1, { name: '旧数据改' })?.name, '旧数据改');
      const updated = User.findById(1);
      assert.ok(typeof updated?.updatedAt === 'string');
      assert.equal(updated?.createdAt, null);
      db.close();
    } finally {
      cleanup();
    }
  });
});
