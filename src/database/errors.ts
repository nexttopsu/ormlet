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
 * 事务使用不当：嵌套调用 `db.transaction()`、在事务中关闭数据库等。
 * 与 `ValidationError` 分开，便于调用方区分「参数写错」和「事务状态不对」。
 */
export class TransactionError extends SqlModelError {}

/**
 * 数据库被其他连接锁定，且在 busy timeout 内始终未能取得锁时抛出。
 * 继承自 SqlModelError，可通过 `instanceof LockTimeoutError` 与普通 SQL 错误区分
 * （`error.errcode` 进一步区分 SQLITE_BUSY / SQLITE_LOCKED），捕获后可以重试。
 */
export class LockTimeoutError extends SqlModelError {
  /** 触发该错误的原始 errcode（SQLITE_BUSY / SQLITE_LOCKED 等），便于细粒度判断。 */
  readonly errcode: number | undefined;

  constructor(message: string, errcode?: number) {
    super(message);
    this.errcode = errcode;
  }
}

/**
 * 约束冲突的基类（SQLITE_CONSTRAINT 系列）。
 * 捕获它即可统一处理所有「数据本身不满足表约束」的错误。
 */
export class ConstraintError extends SqlModelError {
  /** 原始 errcode（如 1555 主键冲突、2067 唯一约束冲突） */
  readonly errcode: number | undefined;

  constructor(message: string, errcode?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.errcode = errcode;
  }
}

/**
 * 违反唯一约束：主键或唯一索引上已存在相同值。
 *
 * 与 `SqlModelError` 分开，调用方可以据此实现「冲突则改为更新」而无需匹配错误文本：
 * ```typescript
 * try {
 *   User.create({ email });
 * } catch (error) {
 *   if (error instanceof UniqueConstraintError) User.update(...);
 *   else throw error;
 * }
 * ```
 */
export class UniqueConstraintError extends ConstraintError {}

/** 违反 NOT NULL 约束：必填列为空。 */
export class NotNullConstraintError extends ConstraintError {}

/** 违反外键约束（需先 `PRAGMA foreign_keys = ON` 才会生效）。 */
export class ForeignKeyConstraintError extends ConstraintError {}

/** 违反 CHECK 约束：列值不满足表定义中的检查表达式。 */
export class CheckConstraintError extends ConstraintError {}
