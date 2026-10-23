import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { DatabaseClosedError, InvalidModelError, TransactionError, ValidationError } from './errors.js';
import { hideInternalState } from './internal.js';
import { Model } from './model.js';
import { isLockConflict, isReadOnlyDatabaseError, translateSqliteError } from './sql-error.js';
import type { DatabaseOptions, ModelDefinition, ModelFields } from './types.js';
import { describeValue, validateModelDefinition } from './validate.js';

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

/**
 * 只读连接的重开次数与退避基数。
 * 重开能解决「连接缓存了旧的库状态」，但其他进程切换日志模式的临界区仍在进行时，
 * 新连接照样会被判只读；错开几毫秒重试即可跨过这个窗口。
 */
const READONLY_REOPEN_ATTEMPTS = 5;
const READONLY_REOPEN_BACKOFF_MS = 5;

const JOURNAL_MODES = new Set(['WAL', 'DELETE', 'MEMORY']);

/**
 * `Database` 上需要绑定到实例的公开方法。
 *
 * 与模型一致：方法定义在原型上并依赖 `this`，一旦被解构（`const { transaction } = db`）
 * 或作为回调传递就会丢掉 `this`。构造时绑定一次，`db` 与 `User` 的处理方式不同才奇怪。
 * getter（`isOpen` / `inTransaction` / `busyTimeout`）不在此列：解构 getter 得到的是取值结果。
 */
const BOUND_METHODS = [
  'model',
  'close',
  'transaction',
  'rollback',
  'isLocked',
  'setBusyTimeout',
  'prepare',
  'exec',
  'reopenAfterReadOnly',
] as const;

/** 实例上的内部状态（不可枚举，避免序列化时泄露数据库路径与连接）。 */
const INTERNAL_FIELDS = [
  'connection',
  'path',
  'models',
  'modelNames',
  'tableOwners',
  'closed',
  'resolvedBusyTimeout',
] as const;

/**
 * 读取 `node:sqlite` 的原生事务状态（`DatabaseSync.isTransaction`，Node 22.16+）。
 * 属性不存在时返回 undefined，由调用方退回「试探性开启事务」的探测方式。
 */
function readNativeTransactionState(connection: DatabaseSync): boolean | undefined {
  const value = (connection as DatabaseSync & { isTransaction?: unknown }).isTransaction;
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * 判断两次 `db.model()` 调用描述的是不是同一个模型。
 *
 * 字段比较与声明顺序无关：`{ a, b }` 与 `{ b, a }` 视为同一份定义。
 * 定义本身非法时由 `validateModelDefinition` 直接抛出校验错误，
 * 这样「同名 + 非法定义」不会被误报成「定义不同」。
 */
function matchesDefinition(
  model: Model<ModelFields>,
  definition: ModelDefinition<ModelFields>,
): boolean {
  const { tableName, fields } = validateModelDefinition(definition);
  if (model.tableName !== tableName) return false;
  const declared = model.fields;
  const declaredKeys = Object.keys(declared);
  if (declaredKeys.length !== Object.keys(fields).length) return false;
  for (const key of declaredKeys) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return false;
    if (declared[key] !== fields[key]) return false;
  }
  return true;
}

/**
 * 数据库：统一持有唯一的 `node:sqlite` 连接，
 * 负责模型的注册、建表和资源关闭。所有模型共享该连接。
 */
export class Database {
  private connection: DatabaseSync;
  private readonly path: string;
  // 已注册的模型：用于幂等注册（同名 + 同定义时返回同一个实例）
  private readonly models = new Map<string, Model<ModelFields>>();
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
    this.path = path;
    this.connection = this.openConnection(path, busyTimeout);
    if (journalMode !== undefined && path !== MEMORY_PATH) {
      this.applyJournalMode(journalMode);
    }
    // 内部状态在运行期仍是可枚举属性，序列化 `db` 会把文件路径写进日志
    hideInternalState(this, INTERNAL_FIELDS);
    this.bindPublicMethods();
  }

  /**
   * 把公开方法绑定到实例上，使 `const { transaction, model } = db` 这类写法同样可用。
   * 与模型侧一致：绑定产生的是不可枚举的自有属性，`Object.keys(db)` 的外观不变。
   */
  private bindPublicMethods(): void {
    const prototype = Database.prototype as unknown as Record<string, (this: Database) => unknown>;
    for (const method of BOUND_METHODS) {
      Object.defineProperty(this, method, {
        value: prototype[method]!.bind(this),
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }

  /**
   * 打开连接并设置锁等待时长。
   *
   * `new DatabaseSync()` 本身也会失败（目录不存在、路径是目录、文件没有读权限），
   * 这些错误必须和后续语句一样收敛成 `SqlModelError`，而不是把 node:sqlite 的
   * 裸 `ERR_SQLITE_ERROR` 抛给调用方。失败时关闭半开的连接，避免句柄泄漏。
   */
  private openConnection(path: string, busyTimeout: number): DatabaseSync {
    let connection: DatabaseSync | undefined;
    try {
      connection = new DatabaseSync(path);
      // SQLite 默认 busy timeout 为 0，多连接并发写同一文件时会立即抛
      // "database is locked"；设置等待重试窗口后短时锁冲突可自行恢复
      connection.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
      return connection;
    } catch (error) {
      try {
        connection?.close();
      } catch {
        // 连接可能尚未建立，或已不可用
      }
      translateSqliteError(error, 'Opening the database');
    }
  }

  /**
   * 应用日志模式。切换日志模式需要短暂的独占锁，因此**不能**让打开失败：
   * 拿不到锁时保持原有模式并发出警告，由调用方决定是否重试或改用 busyTimeout。
   * 警告中不包含数据库路径，避免把文件系统布局写进日志。
   */
  private applyJournalMode(journalMode: string): void {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const row = this.connection.prepare(`PRAGMA journal_mode = ${journalMode}`).get() as
          | { journal_mode?: string }
          | undefined;
        const applied = typeof row?.journal_mode === 'string' ? row.journal_mode.toLowerCase() : undefined;
        if (applied === undefined || applied === journalMode.toLowerCase()) return;
        emitWarning(
          `journalMode "${journalMode}" could not be applied; the database kept "${applied}". ` +
            'This usually means another connection is holding the lock',
          'ORM_JOURNAL_MODE_NOT_APPLIED',
        );
        return;
      } catch (error) {
        failure = error;
        // 并发首次初始化时连接可能被判为只读，重开一次即可恢复（重试语句本身无效）
        if (attempt === 0 && isReadOnlyDatabaseError(error) && this.reopenAfterReadOnly()) continue;
        break;
      }
    }
    if (failure !== undefined && !isLockConflict(failure) && !isReadOnlyDatabaseError(failure)) {
      throw failure;
    }
    emitWarning(
      `journalMode "${journalMode}" could not be applied because another connection holds the lock; ` +
        'the database kept its previous journal mode. Reopen it when idle to enable it',
      'ORM_JOURNAL_MODE_NOT_APPLIED',
    );
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
   *
   * **幂等**：同名且 `tableName` 与 `fields` 完全一致的重复调用返回同一个实例，
   * 因此各模块可以各自 `db.model('User', { ... })` 而不必集中到一处注册；
   * 同名但定义不同、或表名已被其他模型占用时抛 InvalidModelError。
   */
  model<F extends ModelFields>(name: string, definition: ModelDefinition<F>): Model<F> {
    this.assertOpen();

    const existing = this.models.get(name);
    if (existing !== undefined) {
      // 定义非法时 matchesDefinition 会直接抛出校验错误，不会误判成「定义不同」
      // 注册表是异构的（每个模型有自己的 F），命中时按调用方声明的 F 返回：
      // 能命中就说明两份定义结构一致，此处的转换是安全的。
      if (matchesDefinition(existing, definition)) return existing as unknown as Model<F>;
      throw new InvalidModelError(
        'A model with this name is already registered with a different definition; ' +
          'a repeated db.model() call must pass the same tableName and fields',
      );
    }

    const model = new Model<F>(this, name, definition);
    this.models.set(name, model as unknown as Model<ModelFields>);
    return model;
  }

  /**
   * @internal 预占模型名与表名，仅供 `Model` 构造函数调用。
   *
   * 唯一性校验放在这里而不是 `model()`，是为了让直接 `new Model(...)`
   * 这条绕过注册表的路径同样受约束。返回的函数在构造失败（建表 / 补列抛错）
   * 时释放占位，避免留下没有对应模型的空壳记录。
   */
  claimModelSlot(name: string, tableName: string): () => void {
    if (this.modelNames.has(name)) {
      throw new InvalidModelError(
        'A model with this name is already registered on this database; model names must be unique',
      );
    }
    // SQLite 的表名大小写不敏感：`users` 与 `Users` 是同一张表，
    // 按原样比较会放过「两个模型各写一张表」的错觉，实际却在互相 ALTER 同一张表
    const tableKey = tableName.toLowerCase();
    const owner = this.tableOwners.get(tableKey);
    if (owner !== undefined) {
      throw new InvalidModelError(
        'This tableName is already used by another model; each model needs its own tableName',
      );
    }
    this.modelNames.add(name);
    this.tableOwners.set(tableKey, name);
    return () => {
      this.modelNames.delete(name);
      this.tableOwners.delete(tableKey);
    };
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
    this.models.clear();
    this.modelNames.clear();
    this.tableOwners.clear();
    this.connection.close();
  }

  /**
   * 当前是否存在未提交的事务（`BEGIN` 之后尚未 `COMMIT` / `ROLLBACK`）。
   *
   * 优先读 `node:sqlite` 的原生状态 `DatabaseSync.isTransaction`（Node 22.16+）：
   * O(1)，而且能反映调用方自己 `db.exec('BEGIN')` 开启的事务——模型层的每个写操作
   * 都要问一次这个状态，靠抛异常探测的代价是它的十倍以上。
   *
   * 旧版本没有该属性时退回探测：SQLite 在事务中执行 `BEGIN` 会立即报
   * "cannot start a transaction within a transaction"，据此判断；
   * 探测成功说明之前不在事务中，立即 `ROLLBACK` 撤掉探测开启的空事务。
   */
  get inTransaction(): boolean {
    this.assertOpen();
    const native = readNativeTransactionState(this.connection);
    if (native !== undefined) return native;
    return this.probeTransactionState();
  }

  /** 兼容路径：靠「再开一个事务」探测状态（`isTransaction` 不可用时使用）。 */
  private probeTransactionState(): boolean {
    try {
      this.connection.exec('BEGIN');
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (/cannot start a transaction within a transaction/i.test(text)) return true;
      translateSqliteError(error, 'Probing the transaction state');
    }
    this.connection.exec('ROLLBACK');
    return false;
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

  /**
   * 在一个写事务中执行 `fn`，返回其返回值。
   *
   * - 使用 `BEGIN IMMEDIATE`：立即取得写锁，避免「先读后写」时升级锁失败导致的 SQLITE_BUSY；
   * - `fn` 正常返回后提交；`fn` 抛出错误时回滚，并把原错误原样抛出；
   * - **不支持嵌套**：已经处于事务中（本方法内部或外部手动 `BEGIN`）时直接抛 `TransactionError`，
   *   而不是用 SAVEPOINT 模拟——模型层的写法只有一种，能避免半提交状态；
   * - `fn` 必须是同步函数：本库的底层 API 全是同步的，异步函数会返回 Promise 并提前提交；
   * - `fn` 内部不要调用 `close()`；关闭会回滚事务，`COMMIT` 时再抛错。
   *
   * 默认 `synchronous = FULL` 下每条写语句都是一次独立事务（一次 fsync），
   * 把多次写入放进同一个事务通常能带来数量级的吞吐提升。
   *
   * @example
   * const count = db.transaction(() => {
   *   User.create({ name: '张三', age: 25 });
   *   User.update(1, { age: 26 });
   *   return User.count();
   * });
   */
  transaction<T>(fn: (db: Database) => T): T {
    this.assertOpen();
    if (typeof fn !== 'function') {
      throw new ValidationError(`transaction() expects a function, received ${describeValue(fn)}`);
    }
    if (this.inTransaction) {
      throw new TransactionError(
        'transaction() cannot be nested: a transaction is already in progress. ' +
          'Reuse the outer transaction instead of opening a new one',
      );
    }
    this.connection.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = fn(this);
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        // 事务可能已被数据库自身终止（例如遇到 SQLITE_FULL 等致命错误），
        // 此时保留原始错误更重要，回滚失败不再覆盖它
      }
      throw error;
    }
    if (this.closed) {
      throw new DatabaseClosedError('The database was closed inside transaction(); changes were rolled back');
    }
    try {
      this.connection.exec('COMMIT');
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        // 同上：保留提交失败的原始错误
      }
      translateSqliteError(error, 'Committing the transaction');
    }
    return result;
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
      translateSqliteError(error, 'Probing the write lock');
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

  /**
   * 逃生舱：在共享连接上预编译一条 SQL，返回底层 `node:sqlite` 的 `StatementSync`。
   *
   * 用于本库暂未封装的场景（建索引、PRAGMA、`VACUUM`、FTS5、JOIN 等）。
   * **不做任何校验**：SQL 原样执行，业务数据值必须自己用 `?` 绑定，不要拼接用户输入。
   * 遇到只读错误时会自动重开连接并重试一次。
   */
  prepare(sql: string): StatementSync {
    this.assertOpen();
    try {
      return this.connection.prepare(sql);
    } catch (error) {
      if (!isReadOnlyDatabaseError(error) || !this.reopenAfterReadOnly()) {
        translateSqliteError(error, 'Preparing a statement');
      }
      try {
        return this.connection.prepare(sql);
      } catch (retryError) {
        translateSqliteError(retryError, 'Preparing a statement');
      }
    }
  }

  /**
   * 逃生舱：在共享连接上执行一段 SQL（可含多条语句），无返回值。
   *
   * 与 `prepare` 一样不做校验，语句里的表名 / 列名只能来自代码常量。
   * 遇到只读错误时会自动重开连接并重试一次。
   */
  exec(sql: string): void {
    this.assertOpen();
    try {
      this.connection.exec(sql);
    } catch (error) {
      if (!isReadOnlyDatabaseError(error) || !this.reopenAfterReadOnly()) {
        translateSqliteError(error, 'Executing a statement');
      }
      try {
        this.connection.exec(sql);
      } catch (retryError) {
        translateSqliteError(retryError, 'Executing a statement');
      }
    }
  }

  /**
   * @internal 供模型层使用：预编译语句但不翻译错误。
   *
   * 模型层需要在错误信息里带上调用点（`create()` / `search()` …），而 `prepare()` /
   * `exec()` 是给调用方用的逃生舱，会先把错误翻译成「Preparing a statement failed」。
   * 一旦在底层翻译掉，`Model.execute` 就再也补不回上下文，因此模型侧走这两个不翻译的入口。
   */
  prepareInternal(sql: string): StatementSync {
    this.assertOpen();
    return this.connection.prepare(sql);
  }

  /** @internal 同上，供模型层执行 DDL（`syncFields` / `deleteField`）。 */
  execInternal(sql: string): void {
    this.assertOpen();
    this.connection.exec(sql);
  }

  /**
   * 手动触发「只读连接恢复」：关闭当前连接、重新打开，并探测一次写能力，成功返回 `true`。
   *
   * 正常情况不需要调用——`prepare` / `exec` / 模型写入路径都会在识别到 `SQLITE_READONLY`
   * 时自动恢复。只有**事务进行中**不会自动恢复（重开连接会丢事务），
   * 此时可以直接调用它拿到明确的布尔结果，或等待事务结束后重试。
   *
   * 触发场景：多个进程同时初始化一个刚创建的空库，其中一个进程正在写文件头 / 切换 WAL，
   * 其他进程的连接会缓存到「库为空」的旧状态并持续拒绝写入（SQLITE_READONLY 不受 busy
   * handler 处理，同一连接上重试语句无效）。重开连接即可拿到最新的库状态。
   *
   * 重开之后仍然「可能」不可写：其他进程此时可能正处于切换日志模式的临界区，
   * 新连接照样会被判只读。因此这里不只重开一次，而是重开后**实际探测一次写能力**
   * （开启并回滚一个 IMMEDIATE 事务），不可写就短暂让出 CPU 后再重开，
   * 直到可写或次数用尽。探测本身不写数据，不会留下副作用。
   *
   * 存在未提交事务时不做重开（否则会静默丢弃事务），返回 false 交由调用方按原错误处理。
   * 日志模式是数据库文件级的持久属性，重开后沿用；连接上也没有长期存活的语句对象，
   * 因此重开不会破坏调用方状态。
   */
  reopenAfterReadOnly(): boolean {
    if (this.closed) return false;
    // 内存库的内容只存在于当前连接里：重开等于换成一个空库，
    // 「修复只读」会直接丢掉全部数据，宁可让调用方按原错误处理
    if (this.path === MEMORY_PATH) return false;
    try {
      if (this.inTransaction) return false;
    } catch {
      return false;
    }

    for (let attempt = 0; attempt < READONLY_REOPEN_ATTEMPTS; attempt++) {
      if (attempt > 0) this.sleepSync(READONLY_REOPEN_BACKOFF_MS * attempt);
      try {
        this.connection.close();
      } catch {
        // 连接可能已不可用；关闭失败不应阻止重开
      }
      try {
        this.connection = new DatabaseSync(this.path);
        this.connection.exec(`PRAGMA busy_timeout = ${this.resolvedBusyTimeout}`);
      } catch {
        // 重开本身失败（例如路径被移除）：留给调用方按原错误抛出
        continue;
      }
      if (this.canWriteNow()) return true;
    }
    return false;
  }

  /** 探测当前连接是否具备写能力：开启并回滚一个 IMMEDIATE 事务，不产生任何写入。 */
  private canWriteNow(): boolean {
    try {
      this.connection.exec('BEGIN IMMEDIATE');
    } catch (error) {
      // 被别的连接占用 → 不是只读问题，交回调用方按锁冲突处理
      return !isReadOnlyDatabaseError(error) && isLockConflict(error);
    }
    try {
      this.connection.exec('ROLLBACK');
    } catch {
      // 回滚失败说明连接已不可用，按不可写处理
      return false;
    }
    return true;
  }

  /**
   * 让出 CPU 一小段时间而不触碰事件循环：重开连接的窗口通常只有几毫秒，
   * 用 Atomics.wait 做同步退避，保证同步 API 的语义不被改成异步。
   */
  private sleepSync(milliseconds: number): void {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, milliseconds);
  }
}
