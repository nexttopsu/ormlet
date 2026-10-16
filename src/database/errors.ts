/**
 * 本库所有错误的基类，可用于统一的 `instanceof SqlModelError` 判断。
 */
export class SqlModelError extends Error {
  /**
   * @param message 错误描述（只包含参数类型等非敏感信息，不含表名 / 字段名 / 业务数据）
   * @param options `cause` 用于挂载底层原始错误，便于排查
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    // 目标为 ES2021，Error 的 cause 选项需 ES2022，这里手动挂载
    if (options !== undefined && options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 数据库已关闭后继续执行操作时抛出。 */
export class DatabaseClosedError extends SqlModelError {}

/** 模型定义非法（表名、字段名、字段类型不合法，或模型名 / 表名重复）时抛出。 */
export class InvalidModelError extends SqlModelError {}

/** CRUD 参数非法（未知字段、值类型不匹配、空数据、非法 id 等）时抛出。 */
export class ValidationError extends SqlModelError {}

/**
 * 数据库被其他连接锁定，且在 busy timeout 内始终未能取得锁时抛出。
 * 继承自 SqlModelError，可通过 `instanceof LockTimeoutError` 与普通 SQL 错误区分，
 * 也可以在捕获后重试（见 `isLockTimeoutError`）。
 */
export class LockTimeoutError extends SqlModelError {
  /** 触发该错误的原始 errcode（SQLITE_BUSY / SQLITE_LOCKED 等），便于细粒度判断。 */
  readonly errcode: number | undefined;

  constructor(message: string, errcode?: number) {
    super(message);
    this.errcode = errcode;
  }
}
