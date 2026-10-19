import type { SQLInputValue } from 'node:sqlite';
import type { FieldType } from './types.js';
import { InvalidModelError, SqlModelError, ValidationError } from './errors.js';

/** 每张表自动创建的自增主键列名。 */
export const PRIMARY_KEY = 'id';

/** 自动维护的时间戳字段：创建时间 / 修改时间（ISO 8601 UTC 字符串，TEXT 存储）。 */
export const CREATED_AT = 'createdAt';
export const UPDATED_AT = 'updatedAt';

/** 库自动管理、随每张表创建的列（不含主键）。 */
export const MANAGED_COLUMNS: ReadonlyArray<readonly [name: string, type: FieldType]> = [
  [CREATED_AT, 'TEXT'],
  [UPDATED_AT, 'TEXT'],
];

/**
 * 表名 / 字段名 / 模型名只允许由字母、数字、下划线组成，且不能以数字开头。
 * 通过该白名单校验后的标识符才会被拼进 SQL（并使用双引号包裹），杜绝注入。
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 字段类型白名单。 */
export const FIELD_TYPES: ReadonlySet<string> = new Set(['TEXT', 'INTEGER', 'REAL', 'BLOB']);

/** 用于错误信息的值描述，避免泄露对象内容，也不受 Symbol/String 差异影响。 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'object' && value !== null) return Object.prototype.toString.call(value);
  return String(value);
}

/**
 * 错误信息中的标识符脱敏。
 *
 * 错误消息可能被日志聚合、上报或返回给终端用户，其中不应出现表名、字段名、
 * 模型名等 schema 信息。因此错误消息只描述「哪个环节出错 + 期望什么」，
 * 不回显调用方传入的标识符，只在需要时描述其类型（避免把注入载荷写进日志）。
 */
export function describeIdentifier(name: unknown): string {
  return `a ${typeof name}`;
}

export function assertIdentifier(
  name: unknown,
  kind: string,
  errorType: new (message: string) => SqlModelError = InvalidModelError,
): asserts name is string {
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
    // 不回显原始输入：非法值可能是注入载荷，也可能是敏感名称
    throw new errorType(
      `Invalid ${kind}: identifiers must match /^[A-Za-z_][A-Za-z0-9_]*$/, received ${describeIdentifier(name)}`,
    );
  }
}

/**
 * 判断字段名是否命中保留的自动管理字段（id / createdAt / updatedAt，大小写不敏感）。
 * 命中时返回其规范名称，否则返回 null。
 */
export function reservedFieldName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === PRIMARY_KEY) return PRIMARY_KEY;
  if (lower === 'createdat') return CREATED_AT;
  if (lower === 'updatedat') return UPDATED_AT;
  return null;
}

export function assertId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new ValidationError(`id must be a positive safe integer, received ${describeValue(id)}`);
  }
  return id;
}

/**
 * 自动管理的时间戳列（createdAt / updatedAt）的类型。
 * 它们不允许写入，但允许作为查询条件（按时间范围查询是最常见的需求之一）。
 */
export function isTimestampField(field: string): boolean {
  const lower = field.toLowerCase();
  return lower === CREATED_AT.toLowerCase() || lower === UPDATED_AT.toLowerCase();
}

/**
 * 校验作为查询条件的时间戳取值：TEXT 列，因此必须是字符串。
 * 字符串按字典序比较，ISO 8601 UTC 格式（本库写入的格式）的字典序与时间序一致。
 */
export function assertTimestampValue(value: unknown): void {
  if (typeof value !== 'string') {
    throw new ValidationError(
      `Timestamp conditions must be ISO 8601 strings (TEXT), received ${describeValue(value)}`,
    );
  }
}

/**
 * 校验批量语句的行数上限选项。
 * 单条语句携带的行数受 SQLite 绑定参数上限约束，这里把上限压到远低于 32766 的安全区间。
 */
export function assertChunkSize(value: unknown, context: string): number {
  if (value === undefined) return 500;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 5000) {
    throw new ValidationError(
      `${context} chunkSize must be an integer between 1 and 5000, received ${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * 校验字段值与声明的字段类型匹配。显式 null 允许（写入 NULL）。
 * INTEGER 额外要求安全整数，避免超出 JS 表示范围后读取报错。
 * 错误消息不包含字段名，避免泄露数据库结构。
 */
export function assertFieldValue(type: FieldType, value: unknown): void {
  if (value === null) return;
  if (type === 'TEXT' && typeof value === 'string') return;
  if (type === 'INTEGER' && typeof value === 'number' && Number.isSafeInteger(value)) return;
  if (type === 'REAL' && typeof value === 'number' && Number.isFinite(value)) return;
  if (type === 'BLOB' && value instanceof Uint8Array) return;
  const expected: Record<FieldType, string> = {
    TEXT: 'a string',
    INTEGER: 'a safe integer number',
    REAL: 'a finite number',
    BLOB: 'a Uint8Array',
  };
  throw new ValidationError(
    `Invalid value for a field of type ${type}: expected ${expected[type]}, received ${describeValue(value)}`,
  );
}

/**
 * 统一处理 node:sqlite 返回的 `number | bigint`：
 * 转为 number 并拒绝超出安全整数范围的值。
 */
export function toSafeInteger(value: number | bigint): number {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(result)) {
    throw new SqlModelError(
      `SQLite returned an integer outside the JavaScript safe integer range: ${describeValue(value)}`,
    );
  }
  return result;
}

export type DataEntry = [field: string, value: SQLInputValue];
