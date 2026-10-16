import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database, DatabaseClosedError, InvalidModelError, ValidationError } from '../src/index.js';

// 传入故意非法的参数时绕过编译期检查，测试运行时校验
const invalid = (value: unknown): never => value as never;

describe('Database', () => {
  test('opens and closes an in-memory database', () => {
    const db = new Database(':memory:');
    assert.equal(db.isOpen, true);
    db.close();
    assert.equal(db.isOpen, false);
  });

  test('close() is idempotent', () => {
    const db = new Database(':memory:');
    db.close();
    db.close();
  });

  test('rejects an invalid database path', () => {
    assert.throws(() => new Database(''), ValidationError);
    assert.throws(() => new Database(invalid(null)), ValidationError);
    assert.throws(() => new Database(invalid(undefined)), ValidationError);
  });

  test('registers a model and creates its table automatically', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } });
    const user = User.create({ name: '张三', age: 25 });
    assert.equal(user.id, 1);
    assert.equal(User.findById(user.id)?.name, '张三');
    db.close();
  });

  test('rejects a duplicate model name', () => {
    const db = new Database(':memory:');
    db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    assert.throws(
      () => db.model('User', { tableName: 'users', fields: { name: 'TEXT' } }),
      InvalidModelError,
    );
    db.close();
  });

  test('rejects a second model reusing an existing tableName', () => {
    const db = new Database(':memory:');
    db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    assert.throws(
      () => db.model('Account', { tableName: 'users', fields: { title: 'TEXT' } }),
      InvalidModelError,
    );
    db.close();
  });

  test('rejects invalid table names', () => {
    const db = new Database(':memory:');
    const badNames = ['bad table', 'users; DROP TABLE users', '1users', 'user-name', 'user"', ''];
    for (const tableName of badNames) {
      assert.throws(
        () => db.model('M', { tableName, fields: { name: 'TEXT' } }),
        InvalidModelError,
        `tableName "${tableName}" should be rejected`,
      );
    }
    db.close();
  });

  test('rejects invalid model definitions', () => {
    const db = new Database(':memory:');

    assert.throws(() => db.model('M1', invalid(null)), InvalidModelError);
    assert.throws(() => db.model('M2', invalid([])), InvalidModelError);
    assert.throws(() => db.model('bad name', { tableName: 't', fields: { a: 'TEXT' } }), InvalidModelError);

    assert.throws(() => db.model('M3', invalid({ fields: { a: 'TEXT' } })), InvalidModelError);
    assert.throws(() => db.model('M4', invalid({ tableName: 't4' })), InvalidModelError);

    assert.throws(() => db.model('M5', { tableName: 't5', fields: {} }), InvalidModelError);

    for (const fieldName of ['bad field', '1field', 'field;x', '']) {
      assert.throws(
        () => db.model('M6', { tableName: 't6', fields: { [fieldName]: 'TEXT' } }),
        InvalidModelError,
        `field name "${fieldName}" should be rejected`,
      );
    }

    assert.throws(() => db.model('M7', { tableName: 't7', fields: { id: 'INTEGER' } }), InvalidModelError);

    assert.throws(() => db.model('M8', invalid({ tableName: 't8', fields: { a: 'VARCHAR(50)' } })), InvalidModelError);
    assert.throws(() => db.model('M9', invalid({ tableName: 't9', fields: { a: 'text' } })), InvalidModelError);

    db.close();
  });

  test('supports multiple models sharing one connection', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    const Post = db.model('Post', { tableName: 'posts', fields: { title: 'TEXT', views: 'INTEGER' } });

    const user = User.create({ name: '张三' });
    const post1 = Post.create({ title: 'Hello', views: 10 });
    const post2 = Post.create({ title: 'World', views: 10 });

    assert.equal(User.count(), 1);
    assert.equal(Post.count(), 2);
    assert.equal(Post.findMany({ views: 10 }).length, 2);
    assert.deepEqual(User.findMany().map((u) => u.name), ['张三']);
    // 不同表的 id 各自独立自增
    assert.equal(user.id, 1);
    assert.equal(post1.id, 1);
    assert.equal(post2.id, 2);

    assert.equal(Post.update(post1.id, { views: 11 }), true);
    assert.equal(Post.findMany({ views: 11 }).length, 1);
    assert.equal(User.delete(user.id), true);
    db.close();
  });

  test('persists data in a file-backed database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlmodel-test-'));
    const file = path.join(dir, 'data.db');
    try {
      const db = new Database(file);
      const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } });
      const created = User.create({ name: '张三', age: 25 });
      db.close();

      const reopened = new Database(file);
      const UserAgain = reopened.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } });
      const found = UserAgain.findById(created.id);
      assert.equal(found?.name, '张三');
      assert.equal(found?.age, 25);
      assert.equal(UserAgain.count(), 1);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects operations after close', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    User.create({ name: '张三' });
    db.close();

    assert.throws(() => db.model('Post', { tableName: 'posts', fields: { title: 'TEXT' } }), DatabaseClosedError);
    assert.throws(() => User.create({ name: '李四' }), DatabaseClosedError);
    assert.throws(() => User.findById(1), DatabaseClosedError);
    assert.throws(() => User.findMany(), DatabaseClosedError);
    assert.throws(() => User.findMany({ name: '李四' }), DatabaseClosedError);
    assert.throws(() => User.update(1, { name: '李四' }), DatabaseClosedError);
    assert.throws(() => User.delete(1), DatabaseClosedError);
    assert.throws(() => User.count(), DatabaseClosedError);
    assert.throws(() => User.search('张三'), DatabaseClosedError);
  });
});
