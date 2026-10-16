import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { DatabaseClosedError, InvalidModelError, ValidationError } from './errors.js';
import { Model } from './model.js';
import { translateSqliteError } from './sql-error.js';
import type { DatabaseOptions, ModelDefinition, ModelFields } from './types.js';
import { describeValue } from './validate.js';

/** 遇到锁时的默认等待时长（毫秒），与 better-sqlite3 等常见库的默认值一致 */
const DEFAULT_BUSY_TIMEOUT = 5000;

/**
 * 数据库：统一持有唯一的 `node:sqlite` 连接，
 * 负责模型的注册、建表和资源关闭。所有模型共享该连接。
 */
export class Database {
  private readonly connection: DatabaseSync;
  // 仅用于模型名查重；模型实例由 model() 直接返回给调用方持有
  private readonly modelNames = new Set<string>();
  private readonly tableOwners = new Map<string, string>();
  private closed = false;

  /**
   * 打开（或创建）一个 SQLite 数据库。
   * @param path 数据库文件路径；传 `':memory:'` 使用内存数据库
   * @param options 可选配置（`busyTimeout`：锁等待时长，默认 5000 毫秒）
   */
  constructor(path: string, options?: DatabaseOptions) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new ValidationError(
        `Database path must be a non-empty string (':memory:' creates an in-memory database), received ${describeValue(path)}`,
      );
    }
    const busyTimeout = this.resolveBusyTimeout(options);
    this.connection = new DatabaseSync(path);
    // SQLite 默认 busy timeout 为 0，多连接并发写同一文件时会立即抛
    // "database is locked"；设置等待重试窗口后短时锁冲突可自行恢复
    this.connection.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
  }

  private resolveBusyTimeout(options: DatabaseOptions | undefined): number {
    if (options === undefined) return DEFAULT_BUSY_TIMEOUT;
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `Database options must be an object with busyTimeout or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== 'busyTimeout') {
        throw new ValidationError(`Unknown option "${key}" in Database options`);
      }
    }
    const { busyTimeout } = options;
    if (busyTimeout === undefined) return DEFAULT_BUSY_TIMEOUT;
    if (typeof busyTimeout !== 'number' || !Number.isSafeInteger(busyTimeout) || busyTimeout < 0) {
      throw new ValidationError(
        `Database options.busyTimeout must be a non-negative integer (milliseconds), received ${describeValue(busyTimeout)}`,
      );
    }
    return busyTimeout;
  }

  /** 数据库是否处于打开状态。 */
  get isOpen(): boolean {
    return !this.closed;
  }

  /**
   * 注册并创建一个数据模型。
   * 模型定义会在创建时校验；不存在的表会自动创建（自增 `id` 主键 + STRICT 模式），
   * 表中缺失的模型字段也会自动补齐。
   * 重复的模型名或表名会抛出 InvalidModelError。
   */
  model<F extends ModelFields>(name: string, definition: ModelDefinition<F>): Model<F> {
    this.assertOpen();
    if (this.modelNames.has(name)) {
      throw new InvalidModelError(
        `Model "${name}" is already registered on this database; model names must be unique`,
      );
    }
    // 表名占用检查必须在构造模型之前：模型构造会建表并补齐字段（ALTER TABLE），
    // 注册失败时不能改动已有表结构
    if (definition !== null && typeof definition === 'object') {
      const owner = this.tableOwners.get(definition.tableName);
      if (owner !== undefined) {
        throw new InvalidModelError(
          `Table "${definition.tableName}" is already used by model "${owner}"; each model needs its own tableName`,
        );
      }
    }
    const model = new Model<F>(this, name, definition);
    this.tableOwners.set(model.tableName, name);
    this.modelNames.add(name);
    return model;
  }

  /**
   * 关闭数据库连接。可安全地重复调用；
   * 关闭后任何模型操作都会抛出 DatabaseClosedError。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.modelNames.clear();
    this.tableOwners.clear();
    this.connection.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DatabaseClosedError(
        'Database is closed; operations are no longer allowed. Create a new Database instance instead.',
      );
    }
  }

  /** @internal 在共享连接上预编译语句（模型内部使用） */
  prepare(sql: string): StatementSync {
    this.assertOpen();
    try {
      return this.connection.prepare(sql);
    } catch (error) {
      translateSqliteError(error, 'Preparing a statement');
    }
  }

  /** @internal 在共享连接上执行 SQL（模型内部使用） */
  exec(sql: string): void {
    this.assertOpen();
    try {
      this.connection.exec(sql);
    } catch (error) {
      translateSqliteError(error, 'Executing a statement');
    }
  }
}
