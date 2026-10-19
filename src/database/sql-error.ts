import { LockTimeoutError, SqlModelError } from './errors.js';

/**
 * SQLite 的锁相关 errcode 与 errstr。
 * SQLITE_BUSY (5)：数据库/表被其他连接占用，等待 busy timeout 后仍未取得锁。
 * SQLITE_LOCKED (6)：同一连接内的共享缓存表锁冲突（例如未重置的语句）。
 * SQLITE_BUSY_SNAPSHOT (517)：WAL 模式下事务快照过期，需重试整个事务。
 */
const LOCK_ERRCODES = new Set([5, 6, 261, 262, 517]);

/** node:sqlite 抛出的错误在结构上具备这些字段；此处只做能力探测，不依赖具体类型。 */
interface SqliteErrorLike {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
}

function asSqliteErrorLike(error: unknown): SqliteErrorLike | undefined {
  return typeof error === 'object' && error !== null ? (error as SqliteErrorLike) : undefined;
}

/**
 * 判断错误是否由 SQLite 的锁冲突引起（而不是语法错误、约束冲突等）。
 * 同时识别 errcode 与 errstr/message 文本，兼容不同 Node.js 版本的字段差异。
 */
export function isLockConflict(error: unknown): boolean {
  const like = asSqliteErrorLike(error);
  if (like === undefined) return false;
  if (typeof like.errcode === 'number' && LOCK_ERRCODES.has(like.errcode)) return true;
  const text = typeof like.errstr === 'string' ? like.errstr : typeof like.message === 'string' ? like.message : '';
  return /database is locked|database table is locked/i.test(text);
}

/**
 * 判断是否是「连接被 SQLite 判为只读」的错误（SQLITE_READONLY 系列）。
 *
 * 典型来源：多个进程同时打开一个刚创建的空数据库文件，其中一个进程正在切换 WAL /
 * 写入文件头，另一个进程的连接会缓存到「库还是空的」这一状态，此后所有写入都报
 * "attempt to write a readonly database"，且重试无效（busy handler 不处理该错误码）。
 * 唯一的恢复方式是关闭并重新打开连接，因此由 Database 层识别后重开一次。
 *
 * 除 errcode 8 外，还覆盖 8 | n 形式的扩展码（如 264 SQLITE_READONLY_RECOVERY、
 * 1032 SQLITE_READONLY_DBMOVED）：它们同样表示「当前连接不能写」，
 * 处理方式一致，都是重开连接。
 */
export function isReadOnlyDatabaseError(error: unknown): boolean {
  const like = asSqliteErrorLike(error);
  if (like === undefined) return false;
  if (typeof like.errcode === 'number' && (like.errcode & 0xff) === 8) return true;
  const text = typeof like.errstr === 'string' ? like.errstr : typeof like.message === 'string' ? like.message : '';
  return /attempt to write a readonly database|readonly database/i.test(text);
}

/**
 * 把底层 SQLite 错误收敛为本库的错误类型：
 * - 锁冲突 → LockTimeoutError（可区分、可重试）；
 * - 其他 SQLite 错误 → SqlModelError，并保留原始错误作为 `cause`，方便排查。
 * 已经是本库错误类型的直接透传，避免二次包装。
 */
export function translateSqliteError(error: unknown, context: string): never {
  if (error instanceof SqlModelError) throw error;

  const like = asSqliteErrorLike(error);
  const errcode = typeof like?.errcode === 'number' ? like.errcode : undefined;
  const raw =
    typeof like?.message === 'string' && like.message.length > 0
      ? like.message
      : typeof like?.errstr === 'string' && like.errstr.length > 0
        ? like.errstr
        : String(error);
  // 原始消息可能包含 SQL 语句片段（含表名、列名），因此不做原样透传
  const detail = errcode === undefined ? 'unknown SQLite error' : `SQLite error ${errcode}`;

  if (isLockConflict(error)) {
    throw new LockTimeoutError(
      `${context} failed: the database is locked by another connection (${detail}). ` +
        'Increase options.busyTimeout, enable WAL journal mode, or avoid long-running transactions on other connections',
      errcode,
    );
  }
  throw new SqlModelError(`${context} failed: ${detail}`, { cause: error });
}
