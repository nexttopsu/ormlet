/**
 * SQLite 字段类型白名单，仅允许以下四种存储类型。
 */
export type FieldType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';

/**
 * 将 SQLite 字段类型映射为对应的 TypeScript 值类型。
 * - TEXT   → string
 * - INTEGER → number
 * - REAL   → number
 * - BLOB   → Uint8Array
 */
export type FieldValue<T extends FieldType> =
  T extends 'BLOB'
    ? Uint8Array
    : T extends 'TEXT'
      ? string
      : T extends 'INTEGER' | 'REAL'
        ? number
        : never;

/**
 * 模型字段定义：字段名 → 字段类型。
 */
export type ModelFields = Record<string, FieldType>;

/**
 * 模型定义，传入 `db.model(name, definition)`。
 */
export interface ModelDefinition<F extends ModelFields> {
  /** 数据表名，必须是合法的 SQL 标识符 */
  tableName: string;
  /** 字段声明 */
  fields: F;
}

/**
 * 根据字段定义推导出的完整行类型（查询结果 / create 返回值）。
 * 每张表自动带有自增主键 `id` 与自动维护的时间戳字段 `createdAt` / `updatedAt`
 * （ISO 8601 UTC 字符串；由旧表迁移的行可能为 NULL）；
 * 未赋值的模型字段在 SQLite 中为 NULL。
 */
export type ModelRow<F extends ModelFields> = {
  id: number;
  createdAt: string | null;
  updatedAt: string | null;
} & {
  [K in keyof F]: FieldValue<F[K]> | null;
};

/**
 * 写入或查询时使用的数据类型：字段可省略，也可显式传 null。
 */
export type ModelData<F extends ModelFields> = {
  [K in keyof F]?: FieldValue<F[K]> | null;
};

/**
 * `findMany` 的排序与分页选项（全部可选）。
 */
export interface QueryOptions<F extends ModelFields> {
  /** 排序字段，必须是模型声明的字段；默认按 `id` 排序 */
  orderBy?: keyof F & string;
  /** 排序方向，默认 `DESC` */
  order?: 'ASC' | 'DESC';
  /** 返回的最大记录数，必须是正整数 */
  limit?: number;
  /** 跳过的记录数，必须是非负整数，且必须与 `limit` 一起使用 */
  offset?: number;
}

/** 模型声明中类型为 TEXT 的字段名（用于 `search` 的字段选项）。 */
export type TextFieldNames<F extends ModelFields> = {
  [K in keyof F]: F[K] extends 'TEXT' ? K : never;
}[keyof F];

/**
 * `search` 的选项：参与搜索的 TEXT 字段 + `findMany` 的排序与分页。
 */
export interface SearchOptions<F extends ModelFields> extends QueryOptions<F> {
  /** 参与关键字搜索的 TEXT 字段；缺省为模型声明的全部 TEXT 字段 */
  fields?: Array<TextFieldNames<F>>;
}

/**
 * `count` 的可选关键字过滤（用于搜索结果的分页总数）。
 */
export interface CountOptions<F extends ModelFields> {
  /** 关键字：对 `fields`（默认全部 TEXT 字段）做 OR LIKE 匹配，与 `where` 等值条件为 AND 关系 */
  keyword?: string;
  /** 参与关键字搜索的 TEXT 字段；缺省为模型声明的全部 TEXT 字段 */
  fields?: Array<TextFieldNames<F>>;
}
