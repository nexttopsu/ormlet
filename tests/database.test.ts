import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Database, DatabaseClosedError, InvalidModelError, LockTimeoutError, Model, SqlModelError, ValidationError } from '../src/index.js';

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

  test('returns the same instance for a repeated identical definition', () => {
    const db = new Database(':memory:');
    const first = db.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } });
    // 字段声明顺序不同也算同一份定义：各模块不必约定书写顺序
    const second = db.model('User', { tableName: 'users', fields: { age: 'INTEGER', name: 'TEXT' } });
    assert.equal(second, first);
    first.create({ name: '张三' });
    assert.equal(second.count(), 1);
    db.close();
  });

  test('rejects a repeated model name with a different definition', () => {
    const db = new Database(':memory:');
    db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    assert.throws(
      () => db.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER' } }),
      InvalidModelError,
    );
    // 表名不同同样算定义不同
    assert.throws(
      () => db.model('User', { tableName: 'users_2', fields: { name: 'TEXT' } }),
      InvalidModelError,
    );
    db.close();
  });

  test('applies the same uniqueness rules to direct construction', () => {
    const db = new Database(':memory:');
    db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });

    // new Model(...) 绕过 db.model()，但不能绕过注册表：表和模型名都已被占用
    assert.throws(
      () => new Model(db, 'Account', { tableName: 'users', fields: { title: 'TEXT' } }),
      InvalidModelError,
    );
    assert.throws(
      () => new Model(db, 'User', { tableName: 'accounts', fields: { title: 'TEXT' } }),
      InvalidModelError,
    );

    // 未占用的名字 + 表名仍然可以构造（构造函数本身是公开的合法入口）
    const Log = new Model(db, 'Log', { tableName: 'logs', fields: { message: 'TEXT' } });
    assert.equal(Log.create({ message: 'hi' }).message, 'hi');
    db.close();
  });

  test('releases a claimed slot when construction fails', () => {
    const db = new Database(':memory:');
    // 直接预占再释放，等价于「构造中途失败」的情形
    const release = db.claimModelSlot('Temp', 'temp');
    assert.throws(() => db.model('Temp', { tableName: 'temp2', fields: { n: 'TEXT' } }), InvalidModelError);
    release();
    // 占位释放后，同名同表可以重新注册
    const Temp = db.model('Temp', { tableName: 'temp', fields: { n: 'TEXT' } });
    assert.equal(Temp.tableName, 'temp');
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

    assert.deepEqual(Post.update(post1.id, { views: 11 })?.views, 11);
    assert.equal(Post.findMany({ views: 11 }).length, 1);
    assert.equal(User.delete(user.id)?.name, '张三');
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

describe('日志模式（WAL）', () => {
  test('文件库默认启用 WAL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-wal-'));
    const file = path.join(dir, 'data.db');
    try {
      const db = new Database(file);
      const raw = new DatabaseSync(file);
      const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      assert.equal(mode.journal_mode, 'wal');
      raw.close();
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('内存库不受 journalMode 影响', () => {
    const db = new Database(':memory:');
    const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
    User.create({ name: '张三' });
    assert.equal(User.count(), 1);
    db.close();
  });

  test('journalMode: DELETE 显式退回回滚日志模式', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-delete-mode-'));
    const file = path.join(dir, 'data.db');
    try {
      const db = new Database(file, { journalMode: 'DELETE' });
      const raw = new DatabaseSync(file);
      const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      assert.equal(mode.journal_mode, 'delete');
      raw.close();
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('WAL 模式下另一连接的只读事务不再阻塞写入', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-wal-read-'));
    const file = path.join(dir, 'data.db');
    const init = new Database(file);
    init.model('A', { tableName: 'a', fields: { name: 'TEXT' } }).create({ name: 'seed' });
    init.close();

    // 子进程开启只读事务并保持 600ms 不提交
    const childCode = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN');
      db.prepare('SELECT COUNT(*) FROM a').get();
      console.log('READING');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 600);
    `;
    const child = spawn(process.execPath, ['--no-warnings', '-e', childCode, file], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise<void>((resolve) => {
        child.stdout.on('data', (buf: Buffer) => {
          if (buf.toString().includes('READING')) resolve();
        });
      });

      const db = new Database(file, { busyTimeout: 0 });
      const A = db.model('A', { tableName: 'a', fields: { name: 'TEXT' } });
      // WAL 下写入不再被只读事务阻塞；回滚日志模式下这里会抛 LockTimeoutError
      assert.doesNotThrow(() => A.create({ name: 'writer' }));
      assert.ok(A.count() >= 2);
      db.close();
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 句柄释放存在延迟，清理失败不影响测试结论
      }
    }
  });

  test('回滚日志模式下同一场景会被锁阻塞（对照）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-delete-read-'));
    const file = path.join(dir, 'data.db');
    const init = new Database(file, { journalMode: 'DELETE' });
    init.model('A', { tableName: 'a', fields: { name: 'TEXT' } }).create({ name: 'seed' });
    init.close();

    const childCode = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN');
      db.prepare('SELECT COUNT(*) FROM a').get();
      console.log('READING');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 600);
    `;
    const child = spawn(process.execPath, ['--no-warnings', '-e', childCode, file], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise<void>((resolve) => {
        child.stdout.on('data', (buf: Buffer) => {
          if (buf.toString().includes('READING')) resolve();
        });
      });

      const db = new Database(file, { journalMode: 'DELETE', busyTimeout: 0 });
      const A = db.model('A', { tableName: 'a', fields: { name: 'TEXT' } });
      assert.throws(() => A.create({ name: 'writer' }), LockTimeoutError);
      db.close();
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 句柄释放存在延迟，清理失败不影响测试结论
      }
    }
  });
});

describe('busy timeout 与同步阻塞控制', () => {
  test('busyTimeout 可读取，默认 5000', () => {
    const db = new Database(':memory:');
    assert.equal(db.busyTimeout, 5000);
    db.close();
  });

  test('setBusyTimeout 可在运行时调整并校验参数', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-bt-'));
    const file = path.join(dir, 'data.db');
    try {
      const db = new Database(file);
      assert.equal(db.busyTimeout, 5000);
      db.setBusyTimeout(100);
      assert.equal(db.busyTimeout, 100);
      db.setBusyTimeout(0);
      assert.equal(db.busyTimeout, 0);
      assert.throws(() => db.setBusyTimeout(-1), ValidationError);
      assert.throws(() => db.setBusyTimeout(1.5), ValidationError);
      assert.throws(() => db.setBusyTimeout(invalid('100')), ValidationError);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('把 busyTimeout 调到 0 可让锁冲突立即失败，不再阻塞', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-nonblocking-'));
    const file = path.join(dir, 'data.db');
    const init = new Database(file, { journalMode: 'DELETE' });
    init.model('A', { tableName: 'a', fields: { name: 'TEXT' } }).create({ name: 'seed' });
    init.close();

    const childCode = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO a (name) VALUES ('child')").run();
      console.log('LOCKED');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 800);
    `;
    const child = spawn(process.execPath, ['--no-warnings', '-e', childCode, file], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise<void>((resolve) => {
        child.stdout.on('data', (buf: Buffer) => {
          if (buf.toString().includes('LOCKED')) resolve();
        });
      });

      const db = new Database(file, { journalMode: 'DELETE' });
      const A = db.model('A', { tableName: 'a', fields: { name: 'TEXT' } });

      // isLocked() 不等待，可用来在写入前判断
      assert.equal(db.isLocked(), true);
      // 默认 5 秒等待在锁被持有期间会一直阻塞事件循环
      db.setBusyTimeout(0);
      const t0 = Date.now();
      assert.throws(() => A.create({ name: 'parent' }), LockTimeoutError);
      // 立返回而不是等满 5 秒
      assert.ok(Date.now() - t0 < 1000, `expected a fast failure, took ${Date.now() - t0}ms`);
      db.close();
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 句柄释放存在延迟，清理失败不影响测试结论
      }
    }
  });

  test('日志模式切换拿不到锁时只警告，不导致打开失败', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ormlet-wal-fallback-'));
    const file = path.join(dir, 'data.db');
    const init = new Database(file, { journalMode: 'DELETE' });
    init.model('A', { tableName: 'a', fields: { name: 'TEXT' } }).create({ name: 'seed' });
    init.close();

    const childCode = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      const ins = db.prepare("INSERT INTO a (name) VALUES ('c')");
      const timer = setInterval(() => ins.run(), 15);
      console.log('WRITING');
      setTimeout(() => { clearInterval(timer); db.close(); process.exit(0); }, 1200);
    `;
    const child = spawn(process.execPath, ['--no-warnings', '-e', childCode, file], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      await new Promise<void>((resolve) => {
        child.stdout.on('data', (buf: Buffer) => {
          if (buf.toString().includes('WRITING')) resolve();
        });
      });

      // 写压下的 WAL 切换必然拿不到独占锁；打开仍应成功
      let db!: Database;
      assert.doesNotThrow(() => {
        db = new Database(file);
      });
      const A = db.model('A', { tableName: 'a', fields: { name: 'TEXT' } });
      assert.ok(A.count() >= 1);
      db.close();
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 句柄释放存在延迟，清理失败不影响测试结论
      }
    }
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

