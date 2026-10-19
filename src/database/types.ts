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
 * `new Database(path, options)` 的可选配置。
 */
export interface DatabaseOptions {
  /**
   * 遇到数据库锁（其他连接正在读写同一文件）时的等待重试时长，毫秒。
   * 默认 5000：等待至多 5 秒，仍拿不到锁才抛出 LockTimeoutError。
   * 设为 0 表示不等待、立即报错。
   *
   * 注意：等待发生在同步 API 内部，会阻塞事件循环至多该时长。
   */
  busyTimeout?: number;
  /**
   * 日志模式，决定读写并发行为。默认 `'WAL'`。
   * - `'WAL'`：写不阻塞读、读不阻塞写，显著降低 "database is locked" 概率（推荐）；
   * - `'DELETE'`：SQLite 默认的回滚日志模式，读事务会阻塞写，仅在特殊场景下使用；
   * - `'MEMORY'`：日志放在内存中，崩溃可能损坏数据库，仅用于一次性临时数据。
   *
   * `:memory:` 内存库忽略该选项。WAL 会额外产生 `-wal` / `-shm` 文件，
   * 且不适用于网络盘 / 云同步盘（那里文件锁不可靠）。
   */
  journalMode?: 'WAL' | 'DELETE' | 'MEMORY';
}

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
 * 查询条件支持的操作符（大小写敏感，均为小写）。
 *
 * - `eq` / `ne`：等值 / 不等（`NULL` 用 `isNull` 表达，`ne` NULL 的语义易错）
 * - `gt` / `gte` / `lt` / `lte`：比较
 * - `in`：集合包含，至少一项；数组元素类型必须与字段类型一致
 * - `between`：闭区间 `[最小值, 最大值]`
 * - `isNull`：`true` → `IS NULL`，`false` → `IS NOT NULL`
 */
export type WhereOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'between' | 'isNull';

/**
 * 单个字段的条件：既可直接给值（等价于 `eq`），也可给操作符对象。
 *
 * 操作符对象按「先列举、后排除」推导，因此字段类型与操作符不匹配时编译期就能发现：
 * `isNull` 只接受布尔值，`in` 只接受数组，`between` 只接受二元组，
 * 其余操作符只接受与字段类型一致的单值。
 */
export type FieldCondition<T> =
  | T
  | null
  | {
      eq?: NonNullable<T>;
      ne?: NonNullable<T>;
      gt?: NonNullable<T>;
      gte?: NonNullable<T>;
      lt?: NonNullable<T>;
      lte?: NonNullable<T>;
      in?: readonly NonNullable<T>[];
      between?: readonly [NonNullable<T>, NonNullable<T>];
      isNull?: boolean;
    };

/**
 * 查询条件：字段 → 条件，多个字段之间为 AND 关系。
 *
 * 可以直接传标量（等值），也可以传操作符对象做范围 / 集合 / 空值判断。
 * 未知字段、类型不匹配、空操作符对象在编译期和运行期都会被拒绝。
 *
 * @example
 * User.findMany({ age: { gte: 18, lt: 60 }, email: { isNull: false } });
 * User.findMany({ status: { in: ['active', 'pending'] } });
 */
export type WhereInput<F extends ModelFields> = {
  [K in keyof F]?: FieldCondition<FieldValue<F[K]>>;
};

/**
 * `findMany` 的排序与分页选项（全部可选）。
 */
export interface QueryOptions<F extends ModelFields> {
  /** 排序字段，必须是模型声明的字段；默认按 `id` 排序 */
  /** 排序字段：模型声明的字段，或自动管理的主键 `"id"` */
  orderBy?: (keyof F & string) | 'id';
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

/**
 * `createMany` 的选项（全部可选）。
 */
export interface CreateManyOptions {
  /**
   * 每条 INSERT 语句携带的最大行数，默认 500。
   * SQLite 单个语句的绑定参数上限为 32766（旧版本 999），该上限限制了单语句可插入的行数；
   * 分批既能避开上限，也能控制单条语句的编译与内存开销。
   */
  chunkSize?: number;
  /**
   * 每行的字段集合不同时是否报错，默认 `true`。
   *
   * - `true`：所有行必须声明完全相同的字段（可以省略为 `undefined`，视为不写该列）。
   *   一旦出现不一致，各行的缺失字段含义就会在 NULL 与「不写入」之间摇摆，因此直接拒绝；
   * - `false`：逐行按 SQL 默认值插入缺失字段。只在这确实是期望行为时使用。
   *
   * 逐行给出的显式 `null` 与省略的 `undefined` 视为等价（都写入 NULL）。
   */
  strictFields?: boolean;
}

/**
 * `upsert` 的选项。
 */
export interface UpsertOptions<F extends ModelFields> {
  /**
   * 冲突判定字段，用于生成 `ON CONFLICT (...)`。
   * 这些列上必须有唯一约束（唯一索引），否则 SQLite 会直接报错。
   * 省略时使用主键 `id`。
   */
  on?: Array<keyof F & string>;
  /**
   * 冲突时的更新内容；省略时用本次传入的数据覆盖（主键 / 时间戳除外）。
   * 显式传空对象表示冲突时不做任何修改。
   */
  update?: ModelData<F>;
}

/**
 * 一对多辅助类型：每行允许使用不同的字段子集。
 * 直接写 `ModelData<F>[]` 会让 TypeScript 对数组元素做「多余属性」联合校验，
 * 导致字段不同的多行被误判为错误，因此这里对每一行单独应用 `ModelData<F>`。
 */
export type ModelDataTuple<F extends ModelFields> = readonly ModelData<F>[];


/**
 * `updateMany` 的选项（全部可选）。
 */
export interface UpdateManyOptions {
  /** 单条 UPDATE 最多影响的行数，默认 500；用于限制单次写锁的持有时间 */
  chunkSize?: number;
}

/**
 * `updateMany` / `deleteMany` 的执行结果。
 */
export interface MutationResult {
  /** 实际修改 / 删除的行数 */
  changes: number;
  /** 实际执行的语句条数（按 chunkSize 分批） */
  statements: number;
}
