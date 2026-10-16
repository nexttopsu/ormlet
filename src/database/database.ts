import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { DatabaseClosedError, InvalidModelError, ValidationError } from './errors.js';
import { Model } from './model.js';
import { isLockConflict, translateSqliteError } from './sql-error.js';
import type { DatabaseOptions, ModelDefinition, ModelFields } from './types.js';
import { describeValue } from './validate.js';

/** 发出进程级警告（与 node:sqlite 的 ExperimentalWarning 同渠道，可用 --no-warnings 静默）。 */
function emitWarning(message: string, code: string): void {
  process.emitWarning(message, { type: 'OrmletWarning', code });
}

/** 遇到锁时的默认等待时长（毫秒），与 better-sqlite3 等常见库的默认值一致 */
const DEFAULT_BUSY_TIMEOUT = 5000;

/** 默认日志模式：WAL 让读写互不阻塞，显著降低 "database is locked" 概率 */
const DEFAULT_JOURNAL_MODE = 'WAL';

/** 内存库没有独立日志文件，journal_mode 对它是空操作。 */
const MEMORY_PATH = ':memory:';

const JOURNAL_MODES = new Set(['WAL', 'DELETE', 'MEMORY']);

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
  /** 最近一次设置的锁等待时长，用于 PRAGMA 查询失败时兜底 */
  private resolvedBusyTimeout = DEFAULT_BUSY_TIMEOUT;

  /**
   * 打开（或创建）一个 SQLite 数据库。
   * @param path 数据库文件路径；传 `':memory:'` 使用内存数据库
   * @param options 可选配置（`busyTimeout`：锁等待时长，默认 5000 毫秒；
   *                `journalMode`：日志模式，默认 WAL）
   */
  constructor(path: string, options?: DatabaseOptions) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new ValidationError(
        `Database path must be a non-empty string (':memory:' creates an in-memory database), received ${describeValue(path)}`,
      );
    }
    const { busyTimeout, journalMode } = this.resolveOptions(options);
    this.resolvedBusyTimeout = busyTimeout;
    this.connection = new DatabaseSync(path);
    try {
      // SQLite 默认 busy timeout 为 0，多连接并发写同一文件时会立即抛
      // "database is locked"；设置等待重试窗口后短时锁冲突可自行恢复
      this.connection.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    } catch (error) {
      // 初始化失败时不能让连接泄漏
      this.connection.close();
      translateSqliteError(error, 'Opening the database');
    }
    if (journalMode !== undefined && path !== MEMORY_PATH) {
      this.applyJournalMode(path, journalMode);
    }
  }

  /**
   * 应用日志模式。切换日志模式需要短暂的独占锁，因此**不能**让打开失败：
   * 拿不到锁时保持原有模式并发出警告，由调用方决定是否重试或改用 busyTimeout。
   */
  private applyJournalMode(path: string, journalMode: string): void {
    try {
      const row = this.connection.prepare(`PRAGMA journal_mode = ${journalMode}`).get() as
        | { journal_mode?: string }
        | undefined;
      const applied = typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : undefined;
      if (applied !== undefined && applied !== journalMode.toLowerCase()) {
        emitWarning(
          `journalMode "${journalMode}" could not be applied to ${path}; the database kept "${applied}". ` +
            'This usually means another connection is holding the lock',
          'ORM_JOURNAL_MODE_NOT_APPLIED',
        );
      }
    } catch (error) {
      if (!isLockConflict(error)) throw error;
      emitWarning(
        `journalMode "${journalMode}" could not be applied to ${path} because another connection holds the lock; ` +
          'the database kept its previous journal mode. Reopen it when idle to enable it',
        'ORM_JOURNAL_MODE_NOT_APPLIED',
      );
    }
  }

  private resolveOptions(options: DatabaseOptions | undefined): {
    busyTimeout: number;
    journalMode: string | undefined;
  } {
    if (options === undefined) {
      return { busyTimeout: DEFAULT_BUSY_TIMEOUT, journalMode: DEFAULT_JOURNAL_MODE };
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `Database options must be an object with busyTimeout/journalMode or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== 'busyTimeout' && key !== 'journalMode') {
        throw new ValidationError(`Unknown option "${key}" in Database options`);
      }
    }

    const { busyTimeout } = options;
    let resolvedTimeout = DEFAULT_BUSY_TIMEOUT;
    if (busyTimeout !== undefined) {
      if (typeof busyTimeout !== 'number' || !Number.isSafeInteger(busyTimeout) || busyTimeout < 0) {
        throw new ValidationError(
          `Database options.busyTimeout must be a non-negative integer (milliseconds), received ${describeValue(busyTimeout)}`,
        );
      }
      resolvedTimeout = busyTimeout;
    }

    const { journalMode } = options;
    if (journalMode === undefined) {
      return { busyTimeout: resolvedTimeout, journalMode: DEFAULT_JOURNAL_MODE };
    }
    if (typeof journalMode !== 'string' || !JOURNAL_MODES.has(journalMode)) {
      throw new ValidationError(
        `Database options.journalMode must be one of ${[...JOURNAL_MODES].join(', ')}, received ${describeValue(journalMode)}`,
      );
    }
    return { busyTimeout: resolvedTimeout, journalMode };
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
   *
   * 若存在未提交的事务，会先回滚并发出警告，而不是让 `close()` 静默丢弃写入。
   * 需要严格把控提交时机时，请显式调用 `rollback()` 自己处理。
   */
  close(): void {
    if (this.closed) return;
    this.rollbackOnClose();
    this.closed = true;
    this.modelNames.clear();
    this.tableOwners.clear();
    this.connection.close();
  }

  /**
   * 当前是否存在未提交的事务（`BEGIN` 之后尚未 `COMMIT` / `ROLLBACK`）。
   * SQLite 的 `autocommit` pragma 为 0 表示事务已开启但未结束。
   */
  get inTransaction(): boolean {
    this.assertOpen();
    const row = this.connection.prepare('PRAGMA autocommit').get() as
      | { autocommit?: number | bigint }
      | undefined;
    const value = row?.autocommit;
    return (typeof value === 'bigint' ? Number(value) : value) === 0;
  }

  /**
   * 回滚当前未提交的事务。
   * 没有进行中的事务时是空操作（SQLite 会因 "no transaction is active" 报错，
   * 这里通过 `inTransaction` 先行判断来规避），返回是否真的回滚了。
   */
  rollback(): boolean {
    this.assertOpen();
    if (!this.inTransaction) return false;
    this.connection.exec('ROLLBACK');
    return true;
  }

  /** 关闭前处理未提交事务：回滚并告警，避免数据被静默丢弃。 */
  private rollbackOnClose(): void {
    // 连接可能已被外部关闭，此时无需也无法再做检查
    let hadTransaction: boolean;
    try {
      hadTransaction = this.inTransaction;
    } catch {
      return;
    }
    if (!hadTransaction) return;
    try {
      this.connection.exec('ROLLBACK');
    } catch {
      // 连接已不可用时把回滚失败降级为警告，不能阻止 close()
    }
    emitWarning(
      'Database closed with an uncommitted transaction; its changes have been rolled back. ' +
        'Call rollback() (or commit your work) before close() to control the outcome explicitly.',
      'ORM_CLOSE_WITH_OPEN_TRANSACTION',
    );
  }

  /**
   * 当前生效的锁等待时长（毫秒）。
   * 等待发生在同步 API 内部，会阻塞事件循环，因此可以用它来估算最坏阻塞时间。
   */
  get busyTimeout(): number {
    this.assertOpen();
    const row = this.connection.prepare('PRAGMA busy_timeout').get() as
      | { timeout?: number | bigint }
      | undefined;
    const value = row?.timeout;
    if (typeof value === 'bigint') return Number(value);
    return value ?? this.resolvedBusyTimeout;
  }

  /**
   * 在运行时调整锁等待时长（毫秒）。
   * 用于在不重建连接的情况下，把「宁可快速失败」的场景切到更短的等待窗口，
   * 从而缩短同步 API 阻塞事件循环的最坏时长。
   */
  setBusyTimeout(milliseconds: number): void {
    this.assertOpen();
    if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new ValidationError(
        `busyTimeout must be a non-negative integer (milliseconds), received ${describeValue(milliseconds)}`,
      );
    }
    this.connection.exec(`PRAGMA busy_timeout = ${milliseconds}`);
    this.resolvedBusyTimeout = milliseconds;
  }

  /**
   * 在不等待的情况下探测数据库当前是否被其他连接锁定。
   * 实现方式：临时把 busy_timeout 置 0，尝试开启并回滚一个 IMMEDIATE 事务。
   * 由于 SQLite 的写锁是连接级的，这不会影响本连接后续操作。
   *
   * 专门提供给「不想被同步等待阻塞」的调用方：先探测，确认可写再执行真正的写入，
   * 避免在事件循环里长时间阻塞。
   */
  isLocked(): boolean {
    this.assertOpen();
    const previous = this.busyTimeout;
    if (this.inTransaction) {
      // 已经处于事务中时无法用 IMMEDIATE 探测，交由调用方自己判断
      return false;
    }
    this.connection.exec('PRAGMA busy_timeout = 0');
    try {
      this.connection.exec('BEGIN IMMEDIATE');
      this.connection.exec('ROLLBACK');
      return false;
    } catch (error) {
      if (isLockConflict(error)) return true;
      throw error;
    } finally {
      this.connection.exec(`PRAGMA busy_timeout = ${previous}`);
    }
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
