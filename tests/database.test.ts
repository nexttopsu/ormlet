import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Database, DatabaseClosedError, InvalidModelError, LockTimeoutError, SqlModelError, ValidationError } from '../src/index.js';

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

  test('validates Database options', () => {
    assert.throws(() => new Database(':memory:', invalid(null)), ValidationError);
    assert.throws(() => new Database(':memory:', invalid([])), ValidationError);
    assert.throws(() => new Database(':memory:', invalid({ busyTimeout: -1 })), ValidationError);
    assert.throws(() => new Database(':memory:', invalid({ busyTimeout: 1.5 })), ValidationError);
    assert.throws(() => new Database(':memory:', invalid({ unknown: true })), ValidationError);
    // 边界值均可接受
    new Database(':memory:', { busyTimeout: 0 }).close();
    new Database(':memory:', {}).close();
    new Database(':memory:', undefined).close();
  });

  test('waits for the lock instead of failing immediately (busy timeout)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-busy-'));
    const file = path.join(dir, 'data.db');
    // 子进程高频写同一文件，制造锁竞争
    const childCode = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec("CREATE TABLE IF NOT EXISTS a (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT) STRICT");
      const insert = db.prepare("INSERT INTO a (name) VALUES ('child')");
      setInterval(() => insert.run(), 20);
    `;
    const child = spawn(process.execPath, ['-e', childCode, file], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const db = new Database(file);
      const A = db.model('A', { tableName: 'a', fields: { name: 'TEXT' } });
      for (let i = 0; i < 10; i++) {
        A.create({ name: `parent-${i}` });
      }
      // 子进程与父进程的写入都应成功落库
      assert.ok(A.count() >= 10);
      db.close();
    } finally {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe('锁超时错误类型', () => {
  test('锁冲突抛出 LockTimeoutError 而不是原始 SQLite 错误', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-lock-type-'));
    const file = path.join(dir, 'data.db');
    const init = new Database(file);
    init.model('A', { tableName: 'a', fields: { name: 'TEXT' } }).create({ name: 'seed' });
    init.close();

    // 子进程持写事务不放，制造必然超时
    const childCode = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO a (name) VALUES ('child')").run();
      console.log('LOCKED');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 800);
    `;
    const child = spawn(process.execPath, ['--no-warnings', '-e', childCode, file], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve) => {
        child.stdout.on('data', (buf: Buffer) => {
          if (buf.toString().includes('LOCKED')) resolve();
        });
      });

      // busyTimeout 设为 0，确保立即超时而不是等 5 秒
      const db = new Database(file, { busyTimeout: 0 });
      const A = db.model('A', { tableName: 'a', fields: { name: 'TEXT' } });
      assert.throws(
        () => A.create({ name: 'parent' }),
        (error: unknown) => {
          assert.ok(error instanceof LockTimeoutError, `expected LockTimeoutError, got ${String(error)}`);
          assert.ok(error instanceof SqlModelError);
          // errcode 为 SQLITE_BUSY / SQLITE_LOCKED 等
          assert.equal(typeof error.errcode, 'number');
          return true;
        },
      );
      // 错误消息不包含表名 / 字段名
      try {
        A.create({ name: 'parent' });
      } catch (error) {
        const message = (error as Error).message;
        assert.ok(!message.includes('INSERT INTO'), 'message should not contain SQL text');
        assert.ok(!message.includes('"a"'), 'message should not contain the table name');
      }
      db.close();
    } finally {
      child.kill();
      // 等子进程真正退出并释放文件句柄，否则 Windows 上删除临时目录会 EBUSY
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 句柄释放存在延迟，清理失败不影响测试结论
      }
    }
  });

  test('普通 SQL 错误被包装成 SqlModelError 并保留 cause', () => {
    const db = new Database(':memory:');
    db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });

    // 通过 exec 触发一个非锁类 SQL 错误（重复建表）
    assert.throws(
      () => db.exec('CREATE TABLE "users" ("x" TEXT)'),
      (error: unknown) => {
        assert.ok(error instanceof SqlModelError);
        assert.ok(!(error instanceof LockTimeoutError));
        // 原始错误挂在 cause 上，便于排查
        assert.ok((error as { cause?: unknown }).cause !== undefined);
        return true;
      },
    );
    db.close();
  });
});

