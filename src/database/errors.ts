/**
 * 本库所有错误的基类，可用于统一的 `instanceof SqlModelError` 判断。
 */
export class SqlModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 数据库已关闭后继续执行操作时抛出。 */
export class DatabaseClosedError extends SqlModelError {}

/** 模型定义非法（表名、字段名、字段类型不合法，或模型名 / 表名重复）时抛出。 */
export class InvalidModelError extends SqlModelError {}

/** CRUD 参数非法（未知字段、值类型不匹配、空数据、非法 id 等）时抛出。 */
export class ValidationError extends SqlModelError {}
