import type { SQLOutputValue, SQLInputValue } from 'node:sqlite';
import type { Database } from './database.js';
import { SqlModelError, TransactionError, ValidationError } from './errors.js';
import { hideInternalState } from './internal.js';
import { translateSqliteError, isReadOnlyDatabaseError } from './sql-error.js';
import type {
  CountOptions,
  CreateManyOptions,
  Cursor,
  DeleteManyOptions,
  FieldType,
  ModelData,
  ModelDataTuple,
  ModelDefinition,
  ModelFields,
  ModelRow,
  MutationResult,
  Page,
  PageOptions,
  ProjectedRow,
  QueryOptions,
  SearchOptions,
  SelectedRow,
  SelectableName,
  UpdateManyOptions,
  UpsertOptions,
  WhereInput,
} from './types.js';
import {
  CREATED_AT,
  MANAGED_COLUMNS,
  PRIMARY_KEY,
  UPDATED_AT,
  assertChunkSize,
  assertFieldValue,
  assertId,
  assertConditionId,
  assertIdList,
  assertIdentifier,
  describeValue,
  isManagedColumn,
  managedColumnType,
  reservedFieldName,
  toSafeInteger,
  validateModelDefinition,
  type DataEntry,
} from './validate.js';

/** 查询条件允许的操作符（白名单，用于拒绝拼写错误与注入）。 */
const WHERE_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'between', 'isNull']);
/** 操作符 → SQL 比较符（`isNull` / `in` / `between` 单独处理）。 */
const COMPARISON_SQL: Readonly<Record<string, string>> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** 单次 IN 列表的最大元素数：受 SQLite 绑定参数上限约束，超出的部分拆成多段 OR。 */
const MAX_IN_ITEMS = 500;

/** `updateMany` / `deleteMany` 的默认分批行数，限制单次写锁持有时间。 */
const DEFAULT_MUTATION_CHUNK = 500;

/** `findPage` 未指定 limit 时的每页条数。 */
const DEFAULT_PAGE_SIZE = 20;

/**
 * 需要在实例上绑定的公开方法。
 *
 * 私有方法只从 `this.xxx()` 调用，不会脱离实例，因此不必绑定；
 * 显式列出而非遍历原型，既能避免把私有方法也变成自有属性，也让 `tsc` 能发现拼写错误。
 */
const BOUND_METHODS = [
  'create',
  'findById',
  'findMany',
  'findOne',
  'exists',
  'findByIds',
  'findPage',
  'search',
  'update',
  'delete',
  'createMany',
  'upsert',
  'upsertMany',
  'updateMany',
  'deleteMany',
  'clear',
  'count',
  'syncFields',
  'deleteField',
] as const;

/** 实例上的内部状态（不可枚举，避免序列化时泄露连接与数据库路径）。 */
const INTERNAL_FIELDS = ['database', 'fieldTypes', 'declaredFields'] as const;

/** 单个字段的一个已解析条件。 */
interface TupleCondition {
  field: string;
  sql: string;
  params: SQLInputValue[];
}

/**
 * 数据模型：绑定到某张表，提供类型安全的基础 CRUD。
 * 所有 SQL 中的表名和字段名均来自创建模型时校验过的配置；
 * 所有数据值一律通过预编译语句参数绑定传入。
 * 每张表自动维护 createdAt / updatedAt 时间戳：创建时写入，更新时自动刷新，不可手动修改。
 */
export class Model<F extends ModelFields = ModelFields> {
  private readonly database: Database;
  private readonly fieldTypes: ReadonlyMap<string, FieldType>;
  /** 声明时的字段表，冻结后对外暴露（`fields` getter）。 */
  private readonly declaredFields: Readonly<F>;

  /** 模型名（注册时使用的名称） */
  readonly name: string;
  /** 绑定的数据表名 */
  readonly tableName: string;

  constructor(database: Database, name: string, definition: ModelDefinition<F>) {
    assertIdentifier(name, 'model name');
    const { tableName, fields } = validateModelDefinition(definition);
    const fieldEntries = Object.entries(fields);

    this.database = database;
    this.name = name;
    this.tableName = tableName;
    this.fieldTypes = new Map(fieldEntries);
    // 浅拷贝后冻结：直接返回调用方传入的对象时，外部改写会让 `fields` 与内部
    // `fieldTypes` 出现两份互相矛盾的声明。
    this.declaredFields = Object.freeze({ ...fields });
    // TS 的 private 只在编译期生效：运行期这三个字段仍是可枚举自有属性，
    // `JSON.stringify(User)` 会连数据库文件路径、连接状态一起输出，因此显式隐藏
    hideInternalState(this, INTERNAL_FIELDS);

    // 唯一性占位必须在建表之前：注册失败时不能改动已有表结构。
    // 放在构造函数里，`new Model(...)` 这条绕过 db.model() 的路径也会被拦下。
    const release = database.claimModelSlot(name, tableName);
    try {
      const columns = [
        ...MANAGED_COLUMNS.map(([fieldName, fieldType]) => `"${fieldName}" ${fieldType}`),
        ...fieldEntries.map(([fieldName, fieldType]) => `"${fieldName}" ${fieldType}`),
      ];
      // STRICT 让 SQLite 在存储层也强制列类型，配合 JS 侧校验形成双重防护
      database.execInternal(
        `CREATE TABLE IF NOT EXISTS "${tableName}" ("${PRIMARY_KEY}" INTEGER PRIMARY KEY AUTOINCREMENT, ${columns.join(', ')}) STRICT`,
      );
      // 表已存在但缺少模型声明的字段时（例如旧版本数据库文件），自动补齐
      this.syncFields();
    } catch (error) {
      // 建表 / 补列失败时释放占位，避免注册表里留下没有对应模型的空壳
      release();
      throw error;
    }

    this.bindPublicMethods();
  }

  /**
   * 绑定的数据库连接。
   * 需要 JOIN、子查询或本库未覆盖的写法时，直接用 `User.db.prepare(...)`，
   * 仍然共享同一个连接与事务。
   */
  get db(): Database {
    return this.database;
  }

  /**
   * 模型声明时的字段表（只读）。
   * 用于通用后台、动态表单、导出表头这类需要反射字段的场景，
   * 不必在模型之外再保存一份定义。
   */
  get fields(): Readonly<F> {
    return this.declaredFields;
  }

  /**
   * 把公开方法绑定到实例上。
   *
   * 方法都定义在原型上，依赖 `this`；一旦被解构（`const { create } = User`）
   * 或作为回调传递（`items.map(User.create)`）就会丢 `this`，抛出与业务无关的 TypeError。
   * 这里在构造时绑定一次，代价是每个模型实例多 19 个不可枚举的自有属性。
   *
   * 设为不可枚举，`Object.keys()` / `JSON.stringify()` 的既有外观保持不变。
   */
  private bindPublicMethods(): void {
    const prototype = Model.prototype as unknown as Record<string, (this: Model<F>) => unknown>;
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
   * 插入一条记录，返回包含自动生成 `id` 的完整行。
   * 只接受模型声明的字段；未提供的字段存为 NULL。
   * `createdAt` / `updatedAt` 自动写入当前时间，不可通过参数指定。
   */
  create(data: ModelData<F>): ModelRow<F> {
    const entries = this.validateEntries(data, 'create()');
    // 创建与修改时间在同一时刻生成
    const now = new Date().toISOString();
    entries.push([CREATED_AT, now], [UPDATED_AT, now]);
    const sql =
      `INSERT INTO "${this.tableName}" ` +
      `(${entries.map(([field]) => `"${field}"`).join(', ')}) ` +
      `VALUES (${entries.map(() => '?').join(', ')}) RETURNING *`;
    // 用 RETURNING 在同一条语句里取回插入的行：
    // 少一次「插入后按 id 回读」的往返，多进程并发下也不会读到已被别人改写的状态。
    // 必须用 all() 而不是 get()：get() 只把语句推进一行就返回，隐式事务要等到语句
    // 走完 / 重置才提交，写锁冲突会被推迟到调用方看不见的地方。
    const [raw] = this.execute('create()', (db) => db.prepareInternal(sql).all(...entryValues(entries)));
    if (raw === undefined) {
      // 只有 BEFORE INSERT 触发器用 RAISE(IGNORE) 跳过整行时才会没有返回行
      throw new SqlModelError('create() inserted no row: a BEFORE INSERT trigger ignored it');
    }
    return this.toRow(raw);
  }

  /**
   * 按自增主键查询单条记录，不存在时返回 undefined。
   * 传 `options.select` 时只查询指定列，返回类型相应收窄。
   */
  findById(id: number, options?: { select?: undefined }): ModelRow<F> | undefined;
  findById<K extends SelectableName<F>>(
    id: number,
    options: { select: readonly K[] },
  ): SelectedRow<F, K> | undefined;
  findById(
    id: number,
    options?: { select?: readonly SelectableName<F>[] },
  ): ModelRow<F> | Record<string, SQLOutputValue> | undefined {
    const safeId = assertId(id);
    const columns = this.projection(options?.select, 'findById()');
    return this.selectById(safeId, columns);
  }

  /**
   * 条件查询，多个字段之间为 AND 关系；
   * 不传条件时返回全部记录，默认按 `id` 降序排列。
   * options 可指定排序字段、方向与分页（limit / offset）。
   *
   * `where` 的值既可以是标量（等值），也可以是操作符对象：
   * `{ age: { gte: 18 } }`、`{ status: { in: ['a', 'b'] } }`、
   * `{ deletedAt: { isNull: true } }`、`{ createdAt: { gte: '2026-01-01T00:00:00.000Z' } }`。
   * `createdAt` / `updatedAt` 不可写入，但**可以**作为查询条件。
   */
  findMany(
    where?: WhereInput<F>,
    options?: QueryOptions<F> & { select?: undefined },
  ): ModelRow<F>[];
  findMany<K extends SelectableName<F>>(
    where: WhereInput<F> | undefined,
    options: QueryOptions<F> & { select: readonly K[] },
  ): SelectedRow<F, K>[];
  findMany(
    where?: WhereInput<F>,
    options?: QueryOptions<F>,
  ): ModelRow<F>[] | Array<Record<string, SQLOutputValue>> {
    const conditions = this.validateWhere(where, 'findMany()');
    const { orderBy, order, limit, offset } = this.validateOptions(options);
    const columns = this.projection(options?.select, 'findMany()');
    const params = conditionParams(conditions);
    let sql = `SELECT ${columns} FROM "${this.tableName}"`;
    const clause = conditions.length > 0 ? ` WHERE ${conditions.map((c) => c.sql).join(' AND ')}` : '';
    sql += clause;
    sql += ` ORDER BY "${orderBy}" ${order}`;
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
      if (offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    }
    return this.execute('findMany()', (db) =>
      db
        .prepareInternal(sql)
        .all(...params)
        .map((raw) => this.toRow(raw)),
    );
  }

  /**
   * 查询单条记录，没有匹配时返回 `undefined`。
   * 等价于 `findMany(where, { ...options, limit: 1 })[0]`，但少一次数组分配，
   * 且内部用 `LIMIT 1` 让 SQLite 找到第一行即可停止扫描。
   *
   * 不传 `orderBy` 时按 `id DESC` 取最新的一条（与 `findMany` 的默认一致）；
   * 需要「最早的一条」请显式传 `{ order: 'ASC' }`。
   * 匹配到多行时不会报错，只返回排序后的第一行。
   *
   * @example
   * const user = User.findOne({ email: 'a@example.com' });
   */
  findOne(
    where?: WhereInput<F>,
    options?: Omit<QueryOptions<F>, 'limit' | 'offset'> & { select?: undefined },
  ): ModelRow<F> | undefined;
  findOne<K extends SelectableName<F>>(
    where: WhereInput<F> | undefined,
    options: Omit<QueryOptions<F>, 'limit' | 'offset'> & { select: readonly K[] },
  ): SelectedRow<F, K> | undefined;
  findOne(
    where?: WhereInput<F>,
    options?: Omit<QueryOptions<F>, 'limit' | 'offset'>,
  ): ModelRow<F> | Record<string, SQLOutputValue> | undefined {
    const conditions = this.validateWhere(where, 'findOne()');
    // limit 不在 allowed 里：findOne 的语义决定了它恒为 1，允许传入只会让人以为能取第 N 条
    const { orderBy, order } = this.validateOptions(options, 'findOne()');
    const columns = this.projection(options?.select, 'findOne()');
    const params = conditionParams(conditions);
    let sql = `SELECT ${columns} FROM "${this.tableName}"`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.map((c) => c.sql).join(' AND ')}`;
    sql += ` ORDER BY "${orderBy}" ${order} LIMIT 1`;
    const raw = this.execute('findOne()', (db) => db.prepareInternal(sql).get(...params));
    return raw === undefined ? undefined : this.toRow(raw);
  }

  /**
   * 判断是否存在匹配的记录（`SELECT 1 ... LIMIT 1`）。
   *
   * 只回答「有没有」，不读整行、不做 `COUNT(*)` 全表扫描——注册前查重、外键存在性
   * 检查这类只需要布尔结果的场景应优先用它，而不是 `count(...) > 0`。
   *
   * @example
   * if (User.exists({ email })) throw new Error('already registered');
   */
  exists(where?: WhereInput<F>): boolean {
    const conditions = this.validateWhere(where, 'exists()');
    const params = conditionParams(conditions);
    let sql = `SELECT 1 AS found FROM "${this.tableName}"`;
    if (conditions.length > 0) sql += ` WHERE ${conditions.map((c) => c.sql).join(' AND ')}`;
    sql += ' LIMIT 1';
    const raw = this.execute('exists()', (db) => db.prepareInternal(sql).get(...params));
    return raw !== undefined;
  }

  /**
   * 按主键批量查询，返回与 `ids` 顺序一致的结果数组；不存在的 id 对应 `undefined`。
   *
   * - 一次查询取回全部行（`WHERE id IN (...)`），替代 `ids.map(findById)` 的 N 次往返；
   * - **结果长度恒等于 `ids.length`**，`rows[i]` 与 `ids[i]` 一一对应，不需要再按 id 建索引；
   *   不需要对齐时用 `filter(Boolean)`，或改用 `findMany({ id: { in: ids } })`；
   * - 重复的 id 会返回重复的行（同样保持位置对应）；
   * - 空数组直接返回 `[]`，不执行任何查询。
   *
   * @example
   * const rows = User.findByIds([3, 1, 2]);   // rows[i] 对应 ids[i]
   */
  findByIds(ids: readonly number[]): Array<ModelRow<F> | undefined> {
    assertIdList(ids);
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const byId = new Map<number, ModelRow<F>>();
    const columns = this.projection(undefined, 'findByIds()');
    for (let start = 0; start < unique.length; start += MAX_IN_ITEMS) {
      const batch = unique.slice(start, start + MAX_IN_ITEMS);
      const sql =
        `SELECT ${columns} FROM "${this.tableName}" ` +
        `WHERE "${PRIMARY_KEY}" IN (${batch.map(() => '?').join(', ')})`;
      const rows = this.execute('findByIds()', (db) =>
        db
          .prepareInternal(sql)
          .all(...batch)
          .map((raw) => this.toRow(raw)),
      );
      for (const row of rows) byId.set(row.id, row);
    }
    return ids.map((id) => byId.get(id));
  }

  /**
   * 游标（keyset）分页：按 `(orderBy, id)` 定位起点，而不是用 `OFFSET` 跳过前 N 行。
   *
   * - **深分页不退化**：`OFFSET 100000` 要先扫过 10 万行再丢弃，游标条件可以直接从索引定位，
   *   第 1 页与第 5000 页的成本基本相同；
   * - **结果稳定**：翻页期间有新行插入也不会重复或漏掉已看过的行（`OFFSET` 会整体错位）；
   * - 排序字段有重复值时用主键 `id` 打破平局，保证顺序确定；
   * - 排序字段为 NULL 的行：SQLite 把 NULL 视为最小值，这里保持同样的顺序，
   *   NULL 行之间继续用主键比较——行值比较 `(a, b) > (x, y)` 遇到 NULL 恒为 NULL，不能直接用；
   * - `options.limit` 缺省 20；不接受 `offset`（与游标语义冲突，传了会被拒绝）。
   *
   * @example
   * let cursor = null;
   * for (;;) {
   *   const page = User.findPage({ orderBy: 'age', order: 'ASC', limit: 20, after: cursor });
   *   render(page.items);
   *   if (!page.hasMore) break;
   *   cursor = page.nextCursor;
   * }
   */
  findPage<K extends SelectableName<F> = never>(
    options?: PageOptions<F> & { select?: readonly K[] },
  ): Page<ProjectedRow<F, [K] extends [never] ? undefined : K>>;
  findPage(options?: PageOptions<F> & { select?: readonly SelectableName<F>[] }): Page<
    ModelRow<F> | Record<string, SQLOutputValue>
  > {
    // 实现签名只关心「有没有 select」，返回类型的收窄交给上面的泛型重载
    const { orderBy, order, limit, after } = this.validatePageOptions(options);
    this.assertCursorMatches(orderBy, after);
    const columns = this.projection(options?.select, 'findPage()');
    const cursor = this.cursorCondition(orderBy, order, after);
    const params: SQLInputValue[] = [...cursor.params];

    // 排序字段与主键都必须出现在结果里，否则无法生成下一页的游标
    const needed = orderBy === PRIMARY_KEY ? [PRIMARY_KEY] : [orderBy, PRIMARY_KEY];
    const requested = options?.select as readonly string[] | undefined;
    const missing = requested === undefined ? [] : needed.filter((column) => !requested.includes(column));
    const selectSql =
      missing.length === 0 ? columns : [columns, ...missing.map((column) => `"${column}"`)].join(', ');

    let sql = `SELECT ${selectSql} FROM "${this.tableName}"`;
    if (cursor.sql !== undefined) sql += ` WHERE ${cursor.sql}`;
    // 主键作为次级排序键，保证同值时顺序确定（否则 NULL 段内部的行顺序取决于物理存储）；
    // 按主键排序时它本身就是唯一键，不需要再加一次
    sql +=
      orderBy === PRIMARY_KEY
        ? ` ORDER BY "${PRIMARY_KEY}" ${order}`
        : ` ORDER BY "${orderBy}" ${order}, "${PRIMARY_KEY}" ${order}`;
    // 多取一行用于判断是否还有下一页，避免为翻页多发一次 COUNT
    sql += ' LIMIT ?';
    params.push(limit + 1);

    const rows = this.execute('findPage()', (db) =>
      db
        .prepareInternal(sql)
        .all(...params)
        .map((raw) => this.toRow(raw)),
    );
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? {
              id: last[PRIMARY_KEY] as number,
              value:
                orderBy === PRIMARY_KEY
                  ? null
                  : ((last[orderBy] as string | number | Uint8Array | null) ?? null),
            }
          : null,
    };
  }
  /**
   * 关键字搜索：对 TEXT 字段做子串匹配（`LIKE '%keyword%'`），任意字段命中即返回（OR 语义）。
   * SQLite 的 LIKE 对 ASCII 大小写不敏感；`%` 与 `_` 作为 LIKE 通配符原样生效。
   * `options.fields` 指定参与搜索的 TEXT 字段（默认全部 TEXT 字段），
   * 其余选项与 findMany 一致（orderBy / order / limit / offset）。
   * 关键字（含 `%` 包裹）整体通过参数绑定传入，不拼接 SQL。
   */
  search(keyword: string, options?: SearchOptions<F> & { select?: undefined }): ModelRow<F>[];
  search<K extends SelectableName<F>>(
    keyword: string,
    options: SearchOptions<F> & { select: readonly K[] },
  ): SelectedRow<F, K>[];
  search(
    keyword: string,
    options?: SearchOptions<F>,
  ): ModelRow<F>[] | Array<Record<string, SQLOutputValue>> {
    const kw = this.assertKeyword(keyword, 'search()');
    const { orderBy, order, limit, offset } = this.validateOptions(options, 'search()', ['fields']);
    const fields = this.textSearchFields(options?.fields, 'search()');
    const columns = this.projection(options?.select, 'search()');
    const params: SQLInputValue[] = fields.map(() => `%${kw}%`);
    let sql =
      `SELECT ${columns} FROM "${this.tableName}" ` +
      `WHERE (${fields.map((field) => `"${field}" LIKE ?`).join(' OR ')})`;
    sql += ` ORDER BY "${orderBy}" ${order}`;
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
      if (offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    }
    return this.execute('search()', (db) =>
      db
        .prepareInternal(sql)
        .all(...params)
        .map((raw) => this.toRow(raw)),
    );
  }
  /**
   * 按 id 更新指定记录，只更新传入的字段。
   * `updatedAt` 自动刷新为当前时间。
   *
   * 返回**更新后的整行**；记录不存在时返回 `undefined`
   * （旧版本返回 boolean，`if (User.update(...))` 这种写法对行对象依然成立）。
   * 回读与写入在同一个事务中完成，不会读到并发写入的中间状态。
   *
   * @example
   * const updated = User.update(id, { age: 31 });
   * if (updated === undefined) notFound();
   */
  update(id: number, data: ModelData<F>): ModelRow<F> | undefined {
    const safeId = assertId(id);
    const entries = this.validateEntries(data, 'update()');
    // 修改时间自动刷新
    entries.push([UPDATED_AT, new Date().toISOString()]);
    const sql =
      `UPDATE "${this.tableName}" ` +
      `SET ${entries.map(([field]) => `"${field}" = ?`).join(', ')} ` +
      `WHERE "${PRIMARY_KEY}" = ?`;
    return this.runInTransaction(() => {
      const result = this.execute('update()', (db) =>
        db.prepareInternal(sql).run(...entryValues(entries), safeId),
      );
      if (toSafeInteger(result.changes) === 0) return undefined;
      return this.selectById(safeId) as ModelRow<F> | undefined;
    });
  }

  /**
   * 按 id 删除一条记录。
   *
   * 返回**被删除的那一行**（删除前的快照，可用于审计 / 回收站）；
   * 记录不存在时返回 `undefined`。
   * 先读后删，两步在同一个事务中完成。
   *
   * @example
   * const removed = User.delete(id);
   * if (removed !== undefined) audit.log('deleted', removed);
   */
  delete(id: number): ModelRow<F> | undefined {
    const safeId = assertId(id);
    return this.runInTransaction(() => {
      const row = this.selectById(safeId) as ModelRow<F> | undefined;
      if (row === undefined) return undefined;
      this.execute('delete()', (db) =>
        db.prepareInternal(`DELETE FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" = ?`).run(safeId),
      );
      return row;
    });
  }

  /**
   * 批量插入，返回按参数顺序排列的自增 id。
   *
   * - 整个批次在**一个事务**中完成：默认 `synchronous = FULL` 下每条语句都要 fsync，
   *   批量写入的吞吐通常是逐条 `create()` 的几十倍；
   * - 所有行必须声明相同的字段（见 `CreateManyOptions.strictFields`），
   *   因此一条语句即可插完整批，缺省字段统一写入 NULL；
   * - 不在事务中调用时自动开启并提交；已在事务中时直接参与外层事务（失败不单独回滚）；
   * - 不会逐行回读整行（这也是比循环调用 `create()` 快的主要原因）；
   * - 空数组返回空数组，不执行任何语句；
   * - 返回值来自 `RETURNING`，只包含**真正插入**的行：如果表上有 `RAISE(IGNORE)` 之类
   *   会静默跳过行的触发器，被跳过的行不会出现在返回数组里（长度可能小于入参）。
   *
   * @example
   * const ids = User.createMany([
   *   { name: '张三', age: 25 },
   *   { name: '李四', age: 30 },
   * ]);
   */
  createMany(rows: ModelDataTuple<F>, options?: CreateManyOptions): number[] {
    const { chunkSize, strictFields } = this.validateCreateManyOptions(options);
    if (!Array.isArray(rows)) {
      throw new ValidationError(`createMany() expects an array of objects, received ${describeValue(rows)}`);
    }
    if (rows.length === 0) return [];
    const records = rows.map((row, index) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new ValidationError(
          `createMany() expects an array of objects, received ${describeValue(row)} at index ${index}`,
        );
      }
      const entries = Object.entries(row).filter(([, value]) => value !== undefined);
      for (const [field] of entries) {
        if (this.fieldTypes.get(field) === undefined) throw this.unknownFieldError(field, 'createMany()');
      }
      return new Map(entries);
    });
    // 所有行共用同一组字段与绑定顺序，空行按 NULL 处理
    const fields: string[] = [];
    for (const byField of records) {
      for (const field of byField.keys()) if (!fields.includes(field)) fields.push(field);
    }
    if (fields.length === 0) {
      throw new ValidationError('createMany() requires at least one field per row');
    }
    const values = records.map((byField, index) => {
      if (strictFields && byField.size !== fields.length) {
        throw new ValidationError(
          `createMany() requires every row to have the same fields (row ${index} differs). ` +
            'Set options.strictFields = false to fill the missing fields with NULL',
        );
      }
      return fields.map((field) => {
        const raw = byField.get(field);
        const value = raw === undefined ? null : raw;
        assertFieldValue(this.fieldTypes.get(field)!, value);
        return value as SQLInputValue;
      });
    });
    const now = new Date().toISOString();
    const ids: number[] = [];
    // 单条语句携带的行数同时受 chunkSize 与绑定参数总量限制（每行 fields + 2 个时间戳）
    const perStatement = Math.max(1, Math.min(chunkSize, Math.floor(30000 / (fields.length + 2))));
    this.runInTransaction(() => {
      for (let start = 0; start < values.length; start += perStatement) {
        const batch = values.slice(start, start + perStatement);
        const rowSql = `(${fields.map(() => '?').join(', ')}, ?, ?)`;
        const sql =
          `INSERT INTO "${this.tableName}" ` +
          `(${fields.map((field) => `"${field}"`).join(', ')}, "${CREATED_AT}", "${UPDATED_AT}") ` +
          `VALUES ${batch.map(() => rowSql).join(', ')}`;
        const params: SQLInputValue[] = [];
        for (const row of batch) params.push(...row, now, now);
        // 用 RETURNING 取回真正插入的行，而不是由 lastInsertRowid 反推：
        // 用户自建的 BEFORE INSERT 触发器可以用 RAISE(IGNORE) 静默跳过某些行，
        // 此时「同一语句内的 id 连续」并不成立，反推会返回根本不存在的 id（甚至 0）。
        const inserted = this.execute('createMany()', (db) =>
          db.prepareInternal(`${sql} RETURNING "${PRIMARY_KEY}" AS id`).all(...params),
        );
        for (const row of inserted) ids.push(toSafeInteger(row.id as number | bigint));
      }
    });
    return ids;
  }

  /**
   * 插入一行；若与 `options.on`（默认主键）指定的唯一约束冲突，则更新该行。
   *
   * - `options.on` 指定的列上必须有唯一约束（唯一索引），否则 SQLite 会直接报错；
   * - 省略 `options.update` 时，用本次传入的数据覆盖冲突行（`createdAt` 除外）；
   *   显式传空对象表示冲突时不做任何修改；
   * - 只有真正发生更新时才刷新 `updatedAt`；插入时 `createdAt` / `updatedAt` 同时写入；
   * - 返回最终的整行（回读一次）。
   *
   * @example
   * User.upsert({ email: 'z@example.com', name: '张三' }, { on: ['email'] });
   */
  upsert(data: ModelData<F>, options?: UpsertOptions<F>): ModelRow<F> {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ValidationError(`upsert() expects an object with model fields, received ${describeValue(data)}`);
    }
    const target = this.resolveUpsertTarget(options);
    const now = new Date().toISOString();
    const values = Object.entries(data).filter(([, value]) => value !== undefined);
    // 主键是唯一允许在冲突判定中写入的保留字段（冲突本身依赖它）
    for (const [field, value] of values) {
      if (field === PRIMARY_KEY) {
        assertId(value);
        continue;
      }
      const type = this.fieldTypes.get(field);
      if (type === undefined) throw this.unknownFieldError(field, 'upsert()');
      assertFieldValue(type, value);
    }
    const byField = new Map(values);
    // 显式传空对象表示「冲突时什么都不改」，因此不能用 validateEntries（它拒绝空对象）
    const updateEntries =
      options?.update === undefined
        ? values.filter(([field]) => field !== CREATED_AT)
        : this.validateUpdateEntries(options.update, 'upsert() options.update');
    // 冲突时只更新 update 中列出的字段，其余列保持原值
    const assignable = [...new Set(updateEntries.map(([field]) => field))].filter(
      (field) => field !== PRIMARY_KEY && field !== CREATED_AT,
    );
    const assignments = assignable.map((field) => `"${field}" = excluded."${field}"`);
    // 冲突时刷新 updatedAt；分配列表里已有它时交给 excluded（值相同）
    if (!assignable.includes(UPDATED_AT)) assignments.push(`"${UPDATED_AT}" = excluded."${UPDATED_AT}"`);
    const conflict = `ON CONFLICT (${target.map((field) => `"${field}"`).join(', ')}) `;
    const updateSql = assignable.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${assignments.join(', ')}`;
    // 统一列清单：插入用到的列 ∪ 冲突更新用到的列（缺失的列写入 NULL / 忽略）
    const fields = [
      ...new Set([
        // 更新用到的列即使本次未提供，也要出现在插入列表中，否则 excluded 引用不到
        ...updateEntries.map(([field]) => field),
        ...byField.keys(),
      ]),
    ];
    // data 与 options.update 都为空时列清单为空，拼出来的 SQL 是 `INSERT INTO t () VALUES (, ?, ?)`，
    // 语法错误会以「SQLite error 1」的形式冒出来，难以定位；与 create() 一致地在这里拒绝
    if (fields.length === 0) {
      throw new ValidationError('upsert() requires at least one field');
    }
    const params: SQLInputValue[] = fields.map((field) => {
      if (byField.has(field)) return byField.get(field) as SQLInputValue;
      return (updateEntries.find(([name]) => name === field)?.[1] ?? null) as SQLInputValue;
    });
    params.push(now, now);
    const columns = [...fields, CREATED_AT, UPDATED_AT].map((field) => `"${field}"`).join(', ');
    const placeholders = fields.map(() => '?').join(', ');
    const insertSql = `INSERT INTO "${this.tableName}" (${columns}) VALUES (${placeholders}, ?, ?) `;
    const selectByTargetSql =
      `SELECT * FROM "${this.tableName}" ` +
      `WHERE ${target.map((field) => `"${field}" = ?`).join(' AND ')} LIMIT 1`;
    // 整个 upsert 在一个事务里：DO NOTHING 分支要「先插入、再定位冲突行」两步，
    // 事务保证这两步之间不会被并发写入插进来（与 update / delete 的处理一致）
    return this.runInTransaction(() =>
      this.execute('upsert()', (db) => {
        if (assignable.length === 0) {
          // DO NOTHING 不返回行（冲突时）；RETURNING * 直接给出真正插入的那一行。
          // all() 而非 get()：get() 不会把语句执行完，隐式事务的提交与写锁冲突都会延后
          const [inserted] = db.prepareInternal(`${insertSql}${conflict}DO NOTHING RETURNING *`).all(...params);
          if (inserted !== undefined) return this.toRow(inserted);
          const existing = db
            .prepareInternal(selectByTargetSql)
            .get(...target.map((field) => (byField.get(field) ?? null) as SQLInputValue));
          if (existing === undefined) {
            throw new SqlModelError('The conflicting row could not be located after upsert');
          }
          return this.toRow(existing);
        }
        const [row] = db.prepareInternal(`${insertSql}${conflict}${updateSql} RETURNING *`).all(...params);
        if (row === undefined) {
          throw new SqlModelError('The upserted row could not be read back from the table');
        }
        return this.toRow(row);
      }),
    );
  }

  /**
   * 批量插入或更新，返回语句实际影响的行数。
   *
   * - 冲突判定与更新规则同 `upsert()`，整个批次在一个事务内完成；
   * - 每行逐条执行（不使用多行 VALUES），因此各行字段集合可以不同，缺失字段写入 NULL；
   * - 不逐行回读，只返回影响行数（插入与更新各计 1；`DO NOTHING` 命中的行计 0，
   *   需要知道「哪些行真的变了」时请改用逐条 `upsert()`）。
   */
  upsertMany(rows: ModelDataTuple<F>, options?: UpsertOptions<F>): number {
    // 数组检查必须在前：先读 rows.length 会让 null / 非数组以 TypeError 冒出来
    if (!Array.isArray(rows)) {
      throw new ValidationError(`upsertMany() expects an array of objects, received ${describeValue(rows)}`);
    }
    if (rows.length === 0) return 0;
    const target = this.resolveUpsertTarget(options);
    const now = new Date().toISOString();
    const updateEntries =
      options?.update === undefined
        ? undefined
        : this.validateUpdateEntries(options.update, 'upsertMany() options.update');
    let changes = 0;
    this.runInTransaction(() => {
      for (const [index, row] of rows.entries()) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) {
          throw new ValidationError(
            `upsertMany() expects an array of objects, received ${describeValue(row)} at index ${index}`,
          );
        }
        const values = Object.entries(row).filter(([, value]) => value !== undefined);
        if (values.length === 0) {
          throw new ValidationError(`upsertMany() requires at least one field per row (row ${index} is empty)`);
        }
        for (const [field, value] of values) {
          if (field === PRIMARY_KEY) {
            assertId(value);
            continue;
          }
          const type = this.fieldTypes.get(field);
          if (type === undefined) throw this.unknownFieldError(field, 'upsertMany()');
          assertFieldValue(type, value);
        }
        const byField = new Map(values);
        const updates =
          updateEntries ?? values.filter(([field]) => field !== CREATED_AT);
        const assignable = [...new Set(updates.map(([field]) => field))].filter(
          (field) => field !== PRIMARY_KEY && field !== CREATED_AT,
        );
        const assignments = assignable.map((field) => `"${field}" = excluded."${field}"`);
        if (!assignable.includes(UPDATED_AT)) assignments.push(`"${UPDATED_AT}" = excluded."${UPDATED_AT}"`);
        const fields = [...new Set([...updates.map(([field]) => field), ...byField.keys()])];
        const params: SQLInputValue[] = fields.map((field) =>
          (byField.has(field)
            ? byField.get(field)
            : updates.find(([name]) => name === field)?.[1] ?? null) as SQLInputValue,
        );
        params.push(now, now);
        const sql =
          `INSERT INTO "${this.tableName}" ` +
          `(${[...fields, CREATED_AT, UPDATED_AT].map((field) => `"${field}"`).join(', ')}) ` +
          `VALUES (${fields.map(() => '?').join(', ')}, ?, ?) ` +
          `ON CONFLICT (${target.map((field) => `"${field}"`).join(', ')}) ` +
          (assignable.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${assignments.join(', ')}`);
        const result = this.execute('upsertMany()', (db) => db.prepareInternal(sql).run(...params));
        changes += toSafeInteger(result.changes);
      }
    });
    return changes;
  }

  /**
   * 按条件批量更新，返回受影响的行数与执行的语句数。
   *
   * - 条件与 `findMany` 完全一致（等值与操作符，不支持关键字搜索）；
   * - `data` 中省略的字段保持不变；`updatedAt` 对这一批行统一刷新为同一时刻；
   * - 内部按 `chunkSize` 分批执行，每批一条 `UPDATE`，避免大表一次性持有写锁；
   * - 不在事务中调用时整个操作包在一个事务里，任一批失败则全部回滚；
   * - 空更新对象抛 `ValidationError`（避免「什么都没改却刷新了 updatedAt」）。
   */
  updateMany(where: WhereInput<F>, data: ModelData<F>, options?: UpdateManyOptions): MutationResult {
    const conditions = this.validateWhere(where, 'updateMany()');
    const entries = this.validateEntries(data, 'updateMany()');
    const { chunkSize } = this.validateUpdateManyOptions(options);
    const setParams = entryValues(entries);
    const setSql = entries.map(([field]) => `"${field}" = ?`).join(', ');
    const whereSql = conditions.length > 0 ? conditions.map((c) => c.sql).join(' AND ') : '1 = 1';
    const whereParams = conditionParams(conditions);
    const now = new Date().toISOString();
    let changes = 0;
    let statements = 0;
    this.runInTransaction(() => {
      // 只取主键，避免把整行（含 BLOB）读进内存；主键只增不减，按 id 分批不会漏行
      const ids = this.execute('updateMany()', (db) =>
        db
          .prepareInternal(`SELECT "${PRIMARY_KEY}" AS id FROM "${this.tableName}" WHERE ${whereSql} ORDER BY "${PRIMARY_KEY}"`)
          .all(...whereParams)
          .map((row) => toSafeInteger(row.id as number | bigint)),
      );
      for (let start = 0; start < ids.length; start += chunkSize) {
        const batch = ids.slice(start, start + chunkSize);
        const sql =
          `UPDATE "${this.tableName}" SET ${setSql}, "${UPDATED_AT}" = ? ` +
          `WHERE "${PRIMARY_KEY}" IN (${batch.map(() => '?').join(', ')})`;
        const result = this.execute('updateMany()', (db) =>
          db.prepareInternal(sql).run(...setParams, now, ...batch),
        );
        changes += toSafeInteger(result.changes);
        statements += 1;
      }
    });
    return { changes, statements };
  }

  /**
   * 按条件批量删除，返回受影响的行数与执行的语句数。
   *
   * - 条件与 `findMany` 完全一致；
   * - **不传条件会直接抛错**：`deleteMany()` 与 `deleteMany({})` 都被拒绝。
   *   读取（`findMany()` 返回全表）与删除（清空全表）的代价完全不对称，
   *   一次误调用就是不可恢复的数据丢失，因此清空必须显式声明意图；
   *   确实要清空时用 `clear()`，或传 `{ confirm: 'all' }`；
   * - 内部按 `chunkSize` 分批，整体在一个事务中执行。
   */
  deleteMany(where: WhereInput<F>, options?: DeleteManyOptions): MutationResult {
    return this.deleteManyInternal(where, options);
  }

  /**
   * 清空整张表，等价于 `DELETE FROM table`（不重置自增序列）。
   * 单独成方法是为了让「删全部」在调用处一眼可见，不必依赖阅读条件参数。
   */
  clear(options?: UpdateManyOptions): MutationResult {
    return this.deleteManyInternal(undefined, { ...options, confirm: 'all' });
  }

  private deleteManyInternal(
    where: WhereInput<F> | undefined,
    options: DeleteManyOptions | undefined,
  ): MutationResult {
    // 先校验 options 本身，非法参数（非对象、未知键、chunkSize 越界）才能报出自己的错误，
    // 而不是被后面的条件护栏抢先报成「缺少 where」
    const { chunkSize } = this.validateUpdateManyOptions(options, ['confirm']);
    if (options?.confirm !== undefined && options.confirm !== 'all') {
      throw new ValidationError(
        `deleteMany() options.confirm must be "all", received ${describeValue(options.confirm)}`,
      );
    }
    const conditions = this.validateWhere(where, 'deleteMany()');
    // 护栏必须看「解析后的条件」而不是传入对象的键数：`{ name: undefined }` 有键，
    // 但解析结果为空（= 无条件），按 Object.keys 判断会放行全表删除。
    if (conditions.length === 0 && options?.confirm !== 'all') {
      throw new ValidationError(
        'deleteMany() requires a non-empty where condition; use clear() to delete every row in the table',
      );
    }
    const whereSql = conditions.length > 0 ? conditions.map((c) => c.sql).join(' AND ') : '1 = 1';
    const whereParams = conditionParams(conditions);
    let changes = 0;
    let statements = 0;
    this.runInTransaction(() => {
      const ids = this.execute('deleteMany()', (db) =>
        db
          .prepareInternal(`SELECT "${PRIMARY_KEY}" AS id FROM "${this.tableName}" WHERE ${whereSql} ORDER BY "${PRIMARY_KEY}"`)
          .all(...whereParams)
          .map((row) => toSafeInteger(row.id as number | bigint)),
      );
      for (let start = 0; start < ids.length; start += chunkSize) {
        const batch = ids.slice(start, start + chunkSize);
        const sql = `DELETE FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" IN (${batch.map(() => '?').join(', ')})`;
        const result = this.execute('deleteMany()', (db) => db.prepareInternal(sql).run(...batch));
        changes += toSafeInteger(result.changes);
        statements += 1;
      }
    });
    return { changes, statements };
  }

  /**
   * 统计记录数量，支持与 findMany 一致的条件（等值与操作符）。
   *
   * 默认用 `COUNT(*)` 统计行数；`options.column` 指定列时改用 `COUNT("col")`，
   * 只统计该列非 NULL 的行——两者相减即可得到缺失数量，不需要额外的条件查询。
   * `options.keyword` 可附加关键字过滤（与 search 一致的 OR LIKE 语义），用于搜索结果的分页总数。
   */
  count(where?: WhereInput<F>, options?: CountOptions<F>): number {
    const conditions = this.validateWhere(where, 'count()');
    const opts = this.validateCountOptions(options);
    const params = conditionParams(conditions);
    const clauses: string[] = conditions.map((c) => c.sql);
    if (opts.fields !== undefined && opts.keyword === undefined) {
      throw new ValidationError('count() options.fields requires options.keyword');
    }
    if (opts.keyword !== undefined) {
      const kw = this.assertKeyword(opts.keyword, 'count()');
      const fields = this.textSearchFields(opts.fields, 'count()');
      clauses.push(`(${fields.map((field) => `"${field}" LIKE ?`).join(' OR ')})`);
      params.push(...fields.map(() => `%${kw}%`));
    }
    const target = opts.column === undefined ? '*' : `"${opts.column}"`;
    let sql = `SELECT COUNT(${target}) AS total FROM "${this.tableName}"`;
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    const raw = this.execute('count()', (db) => db.prepareInternal(sql).get(...params));
    const total = raw?.total;
    if (typeof total !== 'number' && typeof total !== 'bigint') {
      throw new SqlModelError('COUNT() did not return an integer');
    }
    return toSafeInteger(total);
  }

  /**
   * 将模型声明的字段同步到数据表：表中缺失的字段自动补建
   * （`ALTER TABLE ... ADD COLUMN`，已存在的行该列为 NULL）。
   * 自动管理的时间戳列（`createdAt` / `updatedAt`）缺失时同样补齐。
   * 只做存在性检查：已存在的字段不做类型核对，表中多余的列也不受影响。
   * 模型注册时会自动执行一次；重复调用是幂等的。
   * 返回本次新增的字段名数组（含自动补齐的时间戳列）。
   */
  syncFields(): string[] {
    // SQLite 列名大小写不敏感，统一小写比较
    const columns = new Set(this.getTableColumns().map((column) => column.toLowerCase()));
    const added: string[] = [];
    for (const [field, type] of this.fieldTypes) {
      if (columns.has(field.toLowerCase())) continue;
      this.execute('syncFields()', (db) =>
        db.execInternal(`ALTER TABLE "${this.tableName}" ADD COLUMN "${field}" ${type}`),
      );
      added.push(field);
    }
    // 自动管理的时间戳列同样需要补齐（例如旧版本库或外部工具创建的表）
    for (const [field, type] of MANAGED_COLUMNS) {
      if (columns.has(field.toLowerCase())) continue;
      this.execute('syncFields()', (db) =>
        db.execInternal(`ALTER TABLE "${this.tableName}" ADD COLUMN "${field}" ${type}`),
      );
      added.push(field);
    }
    return added;
  }

  /**
   * 删除数据表中一个模型未声明的字段（`ALTER TABLE ... DROP COLUMN`）。
   * 为避免误删，保留字段（`id`、`createdAt`、`updatedAt`）和模型声明的字段都会被拒绝（抛 ValidationError）；
   * 字段不存在时返回 false，删除成功返回 true。
   */
  deleteField(field: string): boolean {
    assertIdentifier(field, 'field name', ValidationError);
    const reserved = reservedFieldName(field);
    if (reserved !== null) {
      throw new ValidationError(`Field "${reserved}" is managed automatically and cannot be deleted`);
    }
    const lower = field.toLowerCase();
    for (const declared of this.fieldTypes.keys()) {
      if (declared.toLowerCase() === lower) {
        throw new ValidationError(
          'The field is declared on the model and cannot be deleted. ' +
            'Remove it from the model definition first, then call deleteField to drop the column',
        );
      }
    }
    if (!this.getTableColumns().some((column) => column.toLowerCase() === lower)) {
      return false;
    }
    this.execute('deleteField()', (db) =>
      db.execInternal(`ALTER TABLE "${this.tableName}" DROP COLUMN "${field}"`),
    );
    return true;
  }

  private selectById(id: number, columns = '*'): ModelRow<F> | Record<string, SQLOutputValue> | undefined {
    const raw = this.execute('findById()', (db) =>
      db.prepareInternal(`SELECT ${columns} FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" = ?`).get(id),
    );
    return raw === undefined ? undefined : this.toRow(raw);
  }

  /** 通过 pragma_table_info 表值函数查询当前表的实际列名（表名走参数绑定）。 */
  private getTableColumns(): string[] {
    return this.execute('Reading table columns', (db) =>
      db
        .prepareInternal('SELECT name FROM pragma_table_info(?)')
        .all(this.tableName)
        .map((row) => String(row.name)),
    );
  }

  /**
   * 在共享连接上执行一次数据库操作，并把底层 SQLite 错误收敛为本库错误类型。
   * 语句的预编译与执行都可能因锁冲突失败，因此两者都要包在同一个 try 中。
   *
   * 另一个需要重试的情况是连接被并发首次初始化判为只读（SQLITE_READONLY，errcode 8）：
   * 这种状态重试语句无效，必须先重开连接；写入在只读失败时没有产生副作用，重放是安全的。
   */
  private execute<T>(context: string, operation: (db: Database) => T): T {
    try {
      return operation(this.database);
    } catch (error) {
      if (isReadOnlyDatabaseError(error) && this.database.reopenAfterReadOnly()) {
        try {
          return operation(this.database);
        } catch (retryError) {
          translateSqliteError(retryError, context);
        }
      }
      translateSqliteError(error, context);
    }
  }

  /**
   * 校验写入数据：字段必须在模型白名单内、值类型必须匹配；拒绝空数据。
   */
  private validateEntries(data: ModelData<F>, context: string): DataEntry[] {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ValidationError(
        `${context} expects an object with model fields, received ${describeValue(data)}`,
      );
    }
    const entries: DataEntry[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const type = this.fieldTypes.get(field);
      if (type === undefined) {
        throw this.unknownFieldError(field, context);
      }
      assertFieldValue(type, value);
      entries.push([field, value as SQLInputValue]);
    }
    if (entries.length === 0) {
      throw new ValidationError(`${context} requires at least one field`);
    }
    return entries;
  }

  /**
   * 校验冲突更新用的字段集合：与 `validateEntries` 相同，但**允许空对象**
   * （`upsert` 中空对象表示冲突时不做任何修改，对应 `DO NOTHING`）。
   */
  private validateUpdateEntries(data: ModelData<F>, context: string): DataEntry[] {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ValidationError(
        `${context} expects an object with model fields, received ${describeValue(data)}`,
      );
    }
    const entries: DataEntry[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      const type = this.fieldTypes.get(field);
      if (type === undefined) throw this.unknownFieldError(field, context);
      assertFieldValue(type, value);
      entries.push([field, value as SQLInputValue]);
    }
    return entries;
  }

  /**
   * 校验查询条件并解析为 SQL 片段。
   *
   * - 字段必须是模型声明的字段或托管列（`id` / `createdAt` / `updatedAt`）；
   *   托管列只读，但可以自由作为查询条件（这是刻意与写入路径区分开的）；
   * - 值可以是标量（等价 `eq`）或操作符对象，操作符必须是白名单内的已知键；
   * - `null` 仍然直接拒绝（`column = NULL` 永远不成立），需要判空请用 `{ isNull: true }`；
   * - 空操作符对象 `{}` 视为错误，避免「什么都没筛」却看起来筛过。
   */
  private validateWhere(where: WhereInput<F> | undefined, context: string): TupleCondition[] {
    if (where === undefined) return [];
    if (where === null || typeof where !== 'object' || Array.isArray(where)) {
      throw new ValidationError(
        `${context} expects an object of conditions or undefined, received ${describeValue(where)}`,
      );
    }
    const conditions: TupleCondition[] = [];
    for (const [field, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      // 托管列（id / createdAt / updatedAt）与模型字段一视同仁地可查：
      // 按主键批量取行、按创建时间筛范围都是最常见的查询，没有理由拒绝。
      const type = this.columnType(field);
      if (type === undefined) {
        throw this.unknownFieldError(field, context);
      }
      // 只接受普通对象作为操作符容器（Uint8Array 是 BLOB 值，不是条件对象）
      const isOperatorObject =
        typeof condition === 'object' &&
        condition !== null &&
        !Array.isArray(condition) &&
        !(condition instanceof Uint8Array);
      if (!isOperatorObject) {
        if (condition === null) {
          throw new ValidationError(
            `Field must be a non-null value in ${context}: SQL "column = NULL" never matches any row. ` +
              'Use { isNull: true } to match NULL values',
          );
        }
        this.assertConditionValue(field, type, condition, `${context} conditions`);
        // 主键的等值条件额外要求正安全整数：{ id: 0 } 永远不可能命中，静默返回空数组会掩盖 bug
        // 托管列可以大小写不敏感地书写（{ ID: 0 }），判定也要跟着规范化，否则大小写一变就绕过校验
        if (reservedFieldName(field) === PRIMARY_KEY) assertConditionId(condition);
        conditions.push({ field, sql: `"${field}" = ?`, params: [condition as SQLInputValue] });
        continue;
      }
      const operators = Object.entries(condition as Record<string, unknown>).filter(
        ([, value]) => value !== undefined,
      );
      if (operators.length === 0) {
        throw new ValidationError(`${context} received an empty condition object for a field`);
      }
      const parts: TupleCondition[] = [];
      for (const [operator, value] of operators) {
        if (!WHERE_OPERATORS.has(operator)) {
          throw new ValidationError(
            `${context} received an unknown condition operator; expected one of: ${[...WHERE_OPERATORS].join(', ')}`,
          );
        }
        parts.push({
          field,
          ...this.buildOperator(field, type, operator, value, `${context} conditions`),
        });
      }
      // 同一字段的多个操作符之间是 AND（如 { gte: 18, lt: 60 }）
      if (parts.length === 1) {
        conditions.push(parts[0]!);
      } else {
        conditions.push({
          field,
          sql: `(${parts.map((part) => part.sql).join(' AND ')})`,
          params: parts.flatMap((part) => part.params),
        });
      }
    }
    return conditions;
  }

  /** 把单个操作符解析为 SQL 片段。校验失败时抛出 ValidationError（不含字段名）。 */
  private buildOperator(
    field: string,
    type: FieldType,
    operator: string,
    value: unknown,
    context: string,
  ): { sql: string; params: SQLInputValue[] } {
    if (operator === 'isNull') {
      if (typeof value !== 'boolean') {
        throw new ValidationError(`${context} require a boolean for isNull, received ${describeValue(value)}`);
      }
      return { sql: `"${field}" IS ${value ? '' : 'NOT '}NULL`, params: [] };
    }
    if (operator === 'in') {
      if (!Array.isArray(value) || value.length === 0) {
        throw new ValidationError(
          `${context} require a non-empty array for "in", received ${describeValue(value)}`,
        );
      }
      for (const item of value) {
        if (item === null || item === undefined) {
          throw new ValidationError(`${context} "in" lists cannot contain null; use isNull to match NULL values`);
        }
        this.assertConditionValue(field, type, item, `${context} "in" lists`);
        // 与等值条件保持一致：非正整数的 id 永远不可能命中
        if (reservedFieldName(field) === PRIMARY_KEY) assertConditionId(item);
      }
      // 超长列表分段：SQLite 的绑定参数总数有上限
      const chunks: SQLInputValue[][] = [];
      for (let start = 0; start < value.length; start += MAX_IN_ITEMS) {
        chunks.push(value.slice(start, start + MAX_IN_ITEMS) as SQLInputValue[]);
      }
      return {
        sql:
          chunks.length === 1
            ? `"${field}" IN (${chunks[0]!.map(() => '?').join(', ')})`
            : `(${chunks.map((chunk) => `"${field}" IN (${chunk.map(() => '?').join(', ')})`).join(' OR ')})`,
        params: chunks.flat(),
      };
    }
    if (operator === 'between') {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new ValidationError(
          `${context} require a [min, max] pair for "between", received ${describeValue(value)}`,
        );
      }
      for (const item of value) {
        if (item === null || item === undefined) {
          throw new ValidationError(`${context} "between" bounds cannot be null`);
        }
        this.assertConditionValue(field, type, item, `${context} "between" bounds`);
      }
      return { sql: `"${field}" BETWEEN ? AND ?`, params: value as SQLInputValue[] };
    }
    if (value === null || value === undefined) {
      throw new ValidationError(
        `${context} "${operator}" requires a non-null value; use { isNull: true } to match NULL values`,
      );
    }
    this.assertConditionValue(field, type, value, context);
    return { sql: `"${field}" ${COMPARISON_SQL[operator]} ?`, params: [value as SQLInputValue] };
  }

  /**
   * 校验条件里的单个值。`type` 已由 `columnType()` 统一解析，
   * 托管列（id → INTEGER、时间戳 → TEXT）不需要任何特殊分支。
   */
  private assertConditionValue(_field: string, type: FieldType, value: unknown, _context: string): void {
    assertFieldValue(type, value);
  }

  /**
   * 解析列名对应的存储类型：模型声明的字段优先，其次是托管列。
   * 返回 undefined 表示该列不存在（调用方负责抛出脱敏错误）。
   */
  private columnType(field: string): FieldType | undefined {
    return this.fieldTypes.get(field) ?? managedColumnType(field);
  }

  /**
   * 把列名规范化为数据库中真实的列名：模型字段原样返回，托管列统一大小写
   * （`createdat` → `createdAt`），未知列返回 undefined。
   */
  private canonicalColumn(field: string): string | undefined {
    if (this.fieldTypes.has(field)) return field;
    return reservedFieldName(field) ?? undefined;
  }

  /**
   * 在一个写事务中执行批量操作：已在事务中时直接参与外层事务，
   * 否则开启新事务并在结束后提交（失败时回滚由 `Database.transaction` 负责）。
   */
  private runInTransaction<T>(fn: () => T): T {
    if (this.database.inTransaction) return fn();
    return this.database.transaction(fn);
  }

  /** 解析 upsert 的冲突判定字段：默认主键，否则必须是模型声明且不重复的字段。 */
  private resolveUpsertTarget(options: UpsertOptions<F> | undefined): string[] {
    const on = options?.on;
    if (on === undefined) return [PRIMARY_KEY];
    if (!Array.isArray(on) || on.length === 0) {
      throw new ValidationError(
        `upsert() options.on must be a non-empty array of field names, received ${describeValue(on)}`,
      );
    }
    const seen = new Set<string>();
    for (const field of on) {
      // 主键是默认的冲突目标，显式写出来应当与省略等价
      if (field === PRIMARY_KEY) {
        seen.add(field);
        continue;
      }
      if (typeof field !== 'string' || this.fieldTypes.get(field) === undefined) {
        throw this.unknownFieldError(field, 'upsert() options.on');
      }
      if (seen.has(field)) {
        throw new ValidationError('upsert() options.on contains duplicate fields');
      }
      seen.add(field);
    }
    return [...seen];
  }

  /** 校验 createMany 的选项，并拒绝未知键。 */
  private validateCreateManyOptions(options: CreateManyOptions | undefined): {
    chunkSize: number;
    strictFields: boolean;
  } {
    if (options === undefined) return { chunkSize: 500, strictFields: true };
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `createMany() options must be an object with chunkSize/strictFields or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== 'chunkSize' && key !== 'strictFields') {
        throw new ValidationError(`Unknown option "${key}" in createMany() options`);
      }
    }
    const strictFields = options.strictFields;
    if (strictFields !== undefined && typeof strictFields !== 'boolean') {
      throw new ValidationError(
        `createMany() options.strictFields must be a boolean, received ${describeValue(strictFields)}`,
      );
    }
    return {
      chunkSize: assertChunkSize(options.chunkSize, 'createMany()'),
      strictFields: strictFields ?? true,
    };
  }

  /** 校验 updateMany / deleteMany 的选项，并拒绝未知键。 */
  private validateUpdateManyOptions(
    options: UpdateManyOptions | undefined,
    extraKeys: readonly string[] = [],
  ): { chunkSize: number } {
    if (options === undefined) return { chunkSize: DEFAULT_MUTATION_CHUNK };
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `options must be an object with ${['chunkSize', ...extraKeys].join('/')} or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== 'chunkSize' && !extraKeys.includes(key)) {
        throw new ValidationError(`Unknown option "${key}" in batch mutation options`);
      }
    }
    return { chunkSize: assertChunkSize(options.chunkSize, 'Batch mutations') };
  }

  /**
   * 校验 findMany / search 的排序 / 分页选项。
   * 排序字段必须来自模型声明（保留字段同样拒绝）；limit / offset 限定整数范围；
   * 未知选项键直接报错，避免拼写错误被静默忽略（例如 limit 写错导致全表加载）。
   * extraKeys 允许调用方附带自己的选项键（如 search 的 fields），由调用方自行校验其值。
   */
  private validateOptions(
    options: QueryOptions<F> | SearchOptions<F> | undefined,
    context = 'findMany()',
    extraKeys: readonly string[] = [],
  ): {
    orderBy: string;
    order: 'ASC' | 'DESC';
    limit?: number;
    offset?: number;
  } {
    // findOne 不接受 limit / offset：前者语义上恒为 1，后者没有意义，允许传入只会误导调用方
    const allowed = ['orderBy', 'order', 'limit', 'offset', 'select', ...extraKeys].filter(
      (key) => !(context === 'findOne()' && (key === 'limit' || key === 'offset')),
    );
    if (options === undefined) return { orderBy: PRIMARY_KEY, order: 'DESC' };
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `${context} options must be an object with ${allowed.join('/')} or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (!allowed.includes(key)) {
        throw new ValidationError(`Unknown option "${key}" in ${context} options`);
      }
    }
    let orderBy: string = PRIMARY_KEY;
    if (options.orderBy !== undefined) {
      const field = options.orderBy;
      if (typeof field !== 'string') {
        throw new ValidationError(
          `${context} options.orderBy must be a field declared on the model (or a managed column), received ${describeValue(field)}`,
        );
      }
      // 托管列可以排序：id 是分页的默认键，createdAt 则是「按时间倒序」的自然表达
      const canonical = this.canonicalColumn(field);
      if (canonical === undefined) {
        throw this.unknownFieldError(field, `${context} options.orderBy`);
      }
      orderBy = canonical;
    }
    let order: 'ASC' | 'DESC' = 'DESC';
    if (options.order !== undefined) {
      if (options.order !== 'ASC' && options.order !== 'DESC') {
        throw new ValidationError(
          `${context} options.order must be "ASC" or "DESC", received ${describeValue(options.order)}`,
        );
      }
      order = options.order;
    }
    if (options.limit !== undefined) {
      if (typeof options.limit !== 'number' || !Number.isSafeInteger(options.limit) || options.limit < 1) {
        throw new ValidationError(
          `${context} options.limit must be a positive integer, received ${describeValue(options.limit)}`,
        );
      }
    }
    if (options.offset !== undefined) {
      if (options.limit === undefined) {
        throw new ValidationError(
          `${context} options.offset requires options.limit (SQLite OFFSET requires LIMIT)`,
        );
      }
      if (typeof options.offset !== 'number' || !Number.isSafeInteger(options.offset) || options.offset < 0) {
        throw new ValidationError(
          `${context} options.offset must be a non-negative integer, received ${describeValue(options.offset)}`,
        );
      }
    }
    return { orderBy, order, limit: options.limit, offset: options.offset };
  }

  /** 校验搜索关键字：必须是非空字符串。 */
  private assertKeyword(keyword: unknown, context: string): string {
    if (typeof keyword !== 'string' || keyword.length === 0) {
      throw new ValidationError(
        `${context} keyword must be a non-empty string, received ${describeValue(keyword)}`,
      );
    }
    return keyword;
  }

  /**
   * 解析参与关键字搜索的 TEXT 字段：缺省为模型声明的全部 TEXT 字段。
   * 显式传入时逐项校验（已声明、TEXT 类型、不重复、非空数组）。
   */
  private textSearchFields(fields: unknown, context: string): string[] {
    if (fields === undefined) {
      const textFields = [...this.fieldTypes]
        .filter(([, type]) => type === 'TEXT')
        .map(([field]) => field);
      if (textFields.length === 0) {
        throw new ValidationError(`The model has no TEXT fields to search in ${context}`);
      }
      return textFields;
    }
    if (!Array.isArray(fields)) {
      throw new ValidationError(
        `${context} fields must be an array of TEXT field names, received ${describeValue(fields)}`,
      );
    }
    const seen = new Set<string>();
    for (const field of fields) {
      if (typeof field !== 'string') {
        throw new ValidationError(
          `${context} fields must contain field names, received ${describeValue(field)}`,
        );
      }
      const type = this.fieldTypes.get(field);
      if (type === undefined) {
        throw this.unknownFieldError(field, `${context} fields`);
      }
      if (type !== 'TEXT') {
        throw new ValidationError(
          `The field is ${type}; only TEXT fields can be searched in ${context}`,
        );
      }
      if (seen.has(field)) {
        throw new ValidationError(`Duplicate field in ${context} fields`);
      }
      seen.add(field);
    }
    if (seen.size === 0) {
      throw new ValidationError(`${context} fields must contain at least one TEXT field name`);
    }
    return [...seen];
  }

  /** 校验 count 的可选关键字过滤与列选项。 */
  private validateCountOptions(options: CountOptions<F> | undefined): CountOptions<F> {
    if (options === undefined) return {};
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `count() options must be an object with keyword/fields/column or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== 'keyword' && key !== 'fields' && key !== 'column') {
        throw new ValidationError(`Unknown option "${key}" in count() options`);
      }
    }
    if (options.column !== undefined) {
      const column = options.column;
      if (typeof column !== 'string') {
        throw new ValidationError(
          `count() options.column must be a field declared on the model, received ${describeValue(column)}`,
        );
      }
      if (!isManagedColumn(column) && this.fieldTypes.get(column) === undefined) {
        throw this.unknownFieldError(column, 'count() options.column');
      }
    }
    return options;
  }

  /**
   * 校验 `findPage` 的选项，返回规范化后的值。
   * 与 `findMany` 的区别：`limit` 有默认值（20），且明确拒绝 `offset`。
   */
  private validatePageOptions(options: PageOptions<F> | undefined): {
    orderBy: string;
    order: 'ASC' | 'DESC';
    limit: number;
    after: Cursor | null;
  } {
    const allowed = ['orderBy', 'order', 'limit', 'after', 'select'];
    if (options === undefined) {
      return { orderBy: PRIMARY_KEY, order: 'DESC', limit: DEFAULT_PAGE_SIZE, after: null };
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `findPage() options must be an object with ${allowed.join('/')} or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (!allowed.includes(key)) {
        // offset 是最容易误用的一个：游标分页没有偏移量的概念，给了就得说清楚
        if (key === 'offset') {
          throw new ValidationError(
            'findPage() does not accept options.offset: use options.after with the previous page.nextCursor instead',
          );
        }
        throw new ValidationError(`Unknown option "${key}" in findPage() options`);
      }
    }

    let orderBy: string = PRIMARY_KEY;
    if (options.orderBy !== undefined) {
      if (typeof options.orderBy !== 'string') {
        throw new ValidationError(
          `findPage() options.orderBy must be a field declared on the model (or a managed column), ` +
            `received ${describeValue(options.orderBy)}`,
        );
      }
      const canonical = this.canonicalColumn(options.orderBy);
      if (canonical === undefined) {
        throw this.unknownFieldError(options.orderBy, 'findPage() options.orderBy');
      }
      orderBy = canonical;
    }

    let order: 'ASC' | 'DESC' = 'DESC';
    if (options.order !== undefined) {
      if (options.order !== 'ASC' && options.order !== 'DESC') {
        throw new ValidationError(
          `findPage() options.order must be "ASC" or "DESC", received ${describeValue(options.order)}`,
        );
      }
      order = options.order;
    }

    let limit = DEFAULT_PAGE_SIZE;
    if (options.limit !== undefined) {
      if (typeof options.limit !== 'number' || !Number.isSafeInteger(options.limit) || options.limit < 1) {
        throw new ValidationError(
          `findPage() options.limit must be a positive integer, received ${describeValue(options.limit)}`,
        );
      }
      limit = options.limit;
    }

    return { orderBy, order, limit, after: this.validateCursor(options.after) };
  }

  /** 校验调用方回传的游标；null / undefined 都表示第一页。 */
  private validateCursor(after: Cursor | null | undefined): Cursor | null {
    if (after === undefined || after === null) return null;
    if (typeof after !== 'object' || Array.isArray(after)) {
      throw new ValidationError(
        `findPage() options.after must be a cursor from a previous page, received ${describeValue(after)}`,
      );
    }
    const { id, value } = after as Cursor;
    assertId(id);
    // BLOB 排序字段的游标值是 Uint8Array：原样回传时不能让校验把它挡在第二页外面
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Uint8Array)) {
      throw new ValidationError(
        `findPage() options.after must be a cursor from a previous page, received ${describeValue(after)}`,
      );
    }
    return { id, value };
  }

  /**
   * 校验游标值与排序列的存储类型一致。
   *
   * 游标是「上一页原样回传」的不透明值，类型不匹配只可能来自误用（例如把别的查询的游标、
   * 或从 JSON 里读回来已经变形的值丢进来）。SQLite 跨类型比较不会报错，只会按类型序
   * 静默返回空页或错页，因此这里提前拒绝。
   */
  private assertCursorMatches(orderBy: string, after: Cursor | null): void {
    if (after === null || after.value === null || orderBy === PRIMARY_KEY) return;
    const type = this.columnType(orderBy);
    const value = after.value;
    const matches =
      type === 'BLOB'
        ? value instanceof Uint8Array
        : type === 'TEXT'
          ? typeof value === 'string'
          : typeof value === 'number';
    if (!matches) {
      throw new ValidationError(
        'findPage() options.after does not match the type of the sort column; ' +
          'pass page.nextCursor back unchanged instead of rebuilding it',
      );
    }
  }

  /**
   * 生成「严格排在游标之后」的 WHERE 片段。
   *
   * SQLite 把 NULL 视为最小值，因此 `ORDER BY col` 与 `ORDER BY col DESC` 里 NULL 分别在最前和最后：
   * - 升序：`NULL 段 → 非 NULL 段`
   * - 降序：`非 NULL 段 → NULL 段`
   *
   * 条件按「游标落在 NULL 段 / 非 NULL 段」分别展开：
   * - 游标在 NULL 段：升序时剩余 = 同段更大主键 + 全部非 NULL 行；降序时只剩同段的主键
   * - 游标在非 NULL 段：排序值更靠前者；同值时比主键；降序还要把后面整段 NULL 行带上
   *
   * 不用行值比较 `(a, b) > (?, ?)`：该写法遇到 NULL 恒为 NULL，会静默跳过整段 NULL 行。
   */
  private cursorCondition(
    orderBy: string,
    order: 'ASC' | 'DESC',
    after: Cursor | null,
  ): { sql?: string; params: SQLInputValue[] } {
    if (after === null) return { params: [] };
    const key = `"${orderBy}"`;
    const pk = `"${PRIMARY_KEY}"`;
    const cmp = order === 'ASC' ? '>' : '<';

    if (orderBy === PRIMARY_KEY) {
      return { sql: `${pk} ${cmp} ?`, params: [after.id] };
    }
    if (after.value === null) {
      const sql =
        order === 'ASC'
          ? `(${key} IS NULL AND ${pk} > ?) OR ${key} IS NOT NULL`
          : `(${key} IS NULL AND ${pk} < ?)`;
      return { sql, params: [after.id] };
    }
    const rest = `(${key} ${cmp} ?) OR (${key} = ? AND ${pk} ${cmp} ?)`;
    if (order === 'ASC') {
      // 升序里 NULL 段在游标之前，已经取完了
      return { sql: rest, params: [after.value, after.value, after.id] };
    }
    // 降序里 NULL 段排在所有非 NULL 值之后，越过游标后必然要包含它们
    return { sql: `${rest} OR ${key} IS NULL`, params: [after.value, after.value, after.id] };
  }

  /**
   * 把 `select` 编译成 SELECT 的列清单。
   * 未指定时返回 `*`（行为与之前一致）；指定时必须是非空的已知列名数组。
   * 列名来自模型声明或托管列白名单，其余一律拒绝，因此可以直接拼进 SQL。
   */
  private projection(select: readonly string[] | undefined, context: string): string {
    if (select === undefined) return '*';
    if (!Array.isArray(select)) {
      throw new ValidationError(
        `${context} options.select must be an array of field names, received ${describeValue(select)}`,
      );
    }
    if (select.length === 0) {
      throw new ValidationError(`${context} options.select must contain at least one column`);
    }
    const seen = new Set<string>();
    for (const column of select) {
      if (typeof column !== 'string') {
        throw new ValidationError(
          `${context} options.select must contain field names, received ${describeValue(column)}`,
        );
      }
      // SQLite 列名大小写不敏感，但返回的行对象以 SQL 中的列名为键；
      // 托管列按规范名输出，模型字段按声明时的写法输出，保证调用方拿到的键与请求一致
      const canonical = isManagedColumn(column) ? reservedFieldName(column) ?? column : column;
      if (seen.has(canonical)) {
        throw new ValidationError(`Duplicate column in ${context} options.select`);
      }
      seen.add(canonical);
      if (!isManagedColumn(canonical) && this.fieldTypes.get(canonical) === undefined) {
        throw this.unknownFieldError(canonical, `${context} options.select`);
      }
    }
    return [...seen].map((column) => `"${column}"`).join(', ');
  }

  /**
   * 未知字段 / 保留字段错误。
   * 错误消息不包含字段名或模型名，避免把数据库结构写进日志或回显给调用方。
   */
  private unknownFieldError(_field: string, context: string): ValidationError {
    const reserved = reservedFieldName(_field);
    if (reserved !== null) {
      return new ValidationError(
        `Field "${reserved}" is managed automatically and cannot be passed to ${context}`,
      );
    }
    return new ValidationError(`The model has no such field in ${context}`);
  }

  /**
   * 将 node:sqlite 返回的 null 原型行对象转换为普通对象，
   * 并把可能出现的 bigint 统一收敛为安全整数。
   */
  private toRow(raw: Record<string, SQLOutputValue>): ModelRow<F> {
    const row: Record<string, SQLOutputValue> = { ...raw };
    for (const key of Object.keys(row)) {
      if (typeof row[key] === 'bigint') {
        row[key] = toSafeInteger(row[key]);
      }
    }
    return row as unknown as ModelRow<F>;
  }
}

function entryValues(entries: DataEntry[]): SQLInputValue[] {
  return entries.map(([, value]) => value);
}

/** 按条件顺序展开绑定参数（与 SQL 中 `?` 的出现顺序一致）。 */
function conditionParams(conditions: TupleCondition[]): SQLInputValue[] {
  return conditions.flatMap((condition) => condition.params);
}
