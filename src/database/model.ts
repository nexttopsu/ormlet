import type { SQLOutputValue, SQLInputValue } from 'node:sqlite';
import type { Database } from './database.js';
import { InvalidModelError, SqlModelError, ValidationError } from './errors.js';
import type {
  CountOptions,
  FieldType,
  ModelData,
  ModelDefinition,
  ModelFields,
  ModelRow,
  QueryOptions,
  SearchOptions,
} from './types.js';
import {
  CREATED_AT,
  FIELD_TYPES,
  MANAGED_COLUMNS,
  PRIMARY_KEY,
  UPDATED_AT,
  assertFieldValue,
  assertId,
  assertIdentifier,
  describeValue,
  reservedFieldName,
  toSafeInteger,
  type DataEntry,
} from './validate.js';

/**
 * 数据模型：绑定到某张表，提供类型安全的基础 CRUD。
 * 所有 SQL 中的表名和字段名均来自创建模型时校验过的配置；
 * 所有数据值一律通过预编译语句参数绑定传入。
 * 每张表自动维护 createdAt / updatedAt 时间戳：创建时写入，更新时自动刷新，不可手动修改。
 */
export class Model<F extends ModelFields = ModelFields> {
  private readonly database: Database;
  private readonly fieldTypes: ReadonlyMap<string, FieldType>;

  /** 模型名（注册时使用的名称） */
  readonly name: string;
  /** 绑定的数据表名 */
  readonly tableName: string;

  constructor(database: Database, name: string, definition: ModelDefinition<F>) {
    assertIdentifier(name, 'model name');
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new InvalidModelError(
        `Model "${name}" definition must be an object with "tableName" and "fields", received ${describeValue(definition)}`,
      );
    }
    const { tableName, fields } = definition;
    if (tableName === undefined || fields === undefined) {
      throw new InvalidModelError(`Model "${name}" definition requires both "tableName" and "fields"`);
    }
    assertIdentifier(tableName, `table name of model "${name}"`);
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new InvalidModelError(
        `fields of model "${name}" must be an object mapping field names to field types, received ${describeValue(fields)}`,
      );
    }
    const fieldEntries = Object.entries(fields);
    if (fieldEntries.length === 0) {
      throw new InvalidModelError(`Model "${name}" must declare at least one field`);
    }
    for (const [fieldName, fieldType] of fieldEntries) {
      assertIdentifier(fieldName, `field name of model "${name}"`);
      const reserved = reservedFieldName(fieldName);
      if (reserved !== null) {
        throw new InvalidModelError(
          `Field "${fieldName}" is reserved (${reserved} is managed automatically) and cannot be declared on model "${name}"`,
        );
      }
      if (typeof fieldType !== 'string' || !FIELD_TYPES.has(fieldType)) {
        throw new InvalidModelError(
          `Invalid type for field "${fieldName}" of model "${name}": expected one of ${[...FIELD_TYPES].join(', ')}, received ${describeValue(fieldType)}`,
        );
      }
    }

    this.database = database;
    this.name = name;
    this.tableName = tableName;
    this.fieldTypes = new Map(fieldEntries);

    const columns = [
      ...MANAGED_COLUMNS.map(([fieldName, fieldType]) => `"${fieldName}" ${fieldType}`),
      ...fieldEntries.map(([fieldName, fieldType]) => `"${fieldName}" ${fieldType}`),
    ];
    // STRICT 让 SQLite 在存储层也强制列类型，配合 JS 侧校验形成双重防护
    database.exec(
      `CREATE TABLE IF NOT EXISTS "${tableName}" ("${PRIMARY_KEY}" INTEGER PRIMARY KEY AUTOINCREMENT, ${columns.join(', ')}) STRICT`,
    );
    // 表已存在但缺少模型声明的字段时（例如旧版本数据库文件），自动补齐
    this.syncFields();
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
      `VALUES (${entries.map(() => '?').join(', ')})`;
    const result = this.database.prepare(sql).run(...entryValues(entries));
    const id = toSafeInteger(result.lastInsertRowid);
    const row = this.selectById(id);
    if (row === undefined) {
      throw new SqlModelError(`Inserted row (id = ${id}) could not be read back from table "${this.tableName}"`);
    }
    return row;
  }

  /**
   * 按自增主键查询单条记录，不存在时返回 undefined。
   */
  findById(id: number): ModelRow<F> | undefined {
    return this.selectById(assertId(id));
  }

  /**
   * 等值条件查询，多个字段之间为 AND 关系；
   * 不传条件时返回全部记录，默认按 `id` 降序排列。
   * options 可指定排序字段、方向与分页（limit / offset）。
   */
  findMany(where?: ModelData<F>, options?: QueryOptions<F>): ModelRow<F>[] {
    const entries = this.validateWhere(where, 'findMany()');
    const { orderBy, order, limit, offset } = this.validateOptions(options);
    const params = entryValues(entries);
    let sql = `SELECT * FROM "${this.tableName}"`;
    if (entries.length > 0) {
      sql += ` WHERE ${entries.map(([field]) => `"${field}" = ?`).join(' AND ')}`;
    }
    sql += ` ORDER BY "${orderBy}" ${order}`;
    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
      if (offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    }
    return this.database
      .prepare(sql)
      .all(...params)
      .map((raw) => this.toRow(raw));
  }

  /**
   * 关键字搜索：对 TEXT 字段做子串匹配（`LIKE '%keyword%'`），任意字段命中即返回（OR 语义）。
   * SQLite 的 LIKE 对 ASCII 大小写不敏感；`%` 与 `_` 作为 LIKE 通配符原样生效。
   * `options.fields` 指定参与搜索的 TEXT 字段（默认全部 TEXT 字段），
   * 其余选项与 findMany 一致（orderBy / order / limit / offset）。
   * 关键字（含 `%` 包裹）整体通过参数绑定传入，不拼接 SQL。
   */
  search(keyword: string, options?: SearchOptions<F>): ModelRow<F>[] {
    const kw = this.assertKeyword(keyword, 'search()');
    const { orderBy, order, limit, offset } = this.validateOptions(options, 'search()', ['fields']);
    const fields = this.textSearchFields(options?.fields, 'search()');
    const params: SQLInputValue[] = fields.map(() => `%${kw}%`);
    let sql =
      `SELECT * FROM "${this.tableName}" ` +
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
    return this.database
      .prepare(sql)
      .all(...params)
      .map((raw) => this.toRow(raw));
  }

  /**
   * 按 id 更新指定记录，只更新传入的字段。
   * `updatedAt` 自动刷新为当前时间；返回是否有记录被修改，记录不存在时返回 false。
   */
  update(id: number, data: ModelData<F>): boolean {
    const safeId = assertId(id);
    const entries = this.validateEntries(data, 'update()');
    // 修改时间自动刷新
    entries.push([UPDATED_AT, new Date().toISOString()]);
    const sql =
      `UPDATE "${this.tableName}" ` +
      `SET ${entries.map(([field]) => `"${field}" = ?`).join(', ')} ` +
      `WHERE "${PRIMARY_KEY}" = ?`;
    const result = this.database.prepare(sql).run(...entryValues(entries), safeId);
    return toSafeInteger(result.changes) > 0;
  }

  /**
   * 按 id 删除一条记录，返回是否有记录被删除。
   */
  delete(id: number): boolean {
    const safeId = assertId(id);
    const result = this.database
      .prepare(`DELETE FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" = ?`)
      .run(safeId);
    return toSafeInteger(result.changes) > 0;
  }

  /**
   * 统计记录数量，支持与 findMany 一致的等值过滤，使用 SQL `COUNT(*)` 实现。
   * `options` 可附加关键字过滤（与 search 一致的 OR LIKE 语义），用于搜索结果的分页总数。
   */
  count(where?: ModelData<F>, options?: CountOptions<F>): number {
    const entries = this.validateWhere(where, 'count()');
    const opts = this.validateCountOptions(options);
    const params = entryValues(entries);
    const clauses: string[] = [];
    if (entries.length > 0) {
      clauses.push(entries.map(([field]) => `"${field}" = ?`).join(' AND '));
    }
    if (opts.fields !== undefined && opts.keyword === undefined) {
      throw new ValidationError('count() options.fields requires options.keyword');
    }
    if (opts.keyword !== undefined) {
      const kw = this.assertKeyword(opts.keyword, 'count()');
      const fields = this.textSearchFields(opts.fields, 'count()');
      clauses.push(`(${fields.map((field) => `"${field}" LIKE ?`).join(' OR ')})`);
      params.push(...fields.map(() => `%${kw}%`));
    }
    let sql = `SELECT COUNT(*) AS total FROM "${this.tableName}"`;
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    const raw = this.database.prepare(sql).get(...params);
    const total = raw?.total;
    if (typeof total !== 'number' && typeof total !== 'bigint') {
      throw new SqlModelError(`COUNT(*) on table "${this.tableName}" did not return an integer`);
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
      this.database.exec(`ALTER TABLE "${this.tableName}" ADD COLUMN "${field}" ${type}`);
      added.push(field);
    }
    // 自动管理的时间戳列同样需要补齐（例如旧版本库或外部工具创建的表）
    for (const [field, type] of MANAGED_COLUMNS) {
      if (columns.has(field.toLowerCase())) continue;
      this.database.exec(`ALTER TABLE "${this.tableName}" ADD COLUMN "${field}" ${type}`);
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
          `Field "${field}" is declared on model "${this.name}" and cannot be deleted. ` +
            'Remove it from the model definition first, then call deleteField to drop the column',
        );
      }
    }
    if (!this.getTableColumns().some((column) => column.toLowerCase() === lower)) {
      return false;
    }
    this.database.exec(`ALTER TABLE "${this.tableName}" DROP COLUMN "${field}"`);
    return true;
  }

  private selectById(id: number): ModelRow<F> | undefined {
    const raw = this.database
      .prepare(`SELECT * FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" = ?`)
      .get(id);
    return raw === undefined ? undefined : this.toRow(raw);
  }

  /** 通过 pragma_table_info 表值函数查询当前表的实际列名（表名走参数绑定）。 */
  private getTableColumns(): string[] {
    return this.database
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all(this.tableName)
      .map((row) => String(row.name));
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
      assertFieldValue(field, type, value);
      entries.push([field, value as SQLInputValue]);
    }
    if (entries.length === 0) {
      throw new ValidationError(`${context} on model "${this.name}" requires at least one field`);
    }
    return entries;
  }

  /**
   * 校验查询条件：与写入相同的字段白名单与类型校验；
   * 额外拒绝 null 条件（SQL 中 `column = NULL` 永远不成立，属于常见误用）。
   */
  private validateWhere(where: ModelData<F> | undefined, context: string): DataEntry[] {
    if (where === undefined) return [];
    if (where === null || typeof where !== 'object' || Array.isArray(where)) {
      throw new ValidationError(
        `${context} expects an object of equality conditions or undefined, received ${describeValue(where)}`,
      );
    }
    const entries: DataEntry[] = [];
    for (const [field, value] of Object.entries(where)) {
      if (value === undefined) continue;
      const type = this.fieldTypes.get(field);
      if (type === undefined) {
        throw this.unknownFieldError(field, context);
      }
      if (value === null) {
        throw new ValidationError(
          `Field "${field}" cannot be null in ${context}: SQL "column = NULL" never matches any row`,
        );
      }
      assertFieldValue(field, type, value);
      entries.push([field, value as SQLInputValue]);
    }
    return entries;
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
    const allowed = ['orderBy', 'order', 'limit', 'offset', ...extraKeys];
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
          `findMany() options.orderBy must be a field declared on model "${this.name}", received ${describeValue(field)}`,
        );
      }
      if (this.fieldTypes.get(field) === undefined) {
        throw this.unknownFieldError(field, 'findMany() options.orderBy');
      }
      orderBy = field;
    }
    let order: 'ASC' | 'DESC' = 'DESC';
    if (options.order !== undefined) {
      if (options.order !== 'ASC' && options.order !== 'DESC') {
        throw new ValidationError(
          `findMany() options.order must be "ASC" or "DESC", received ${describeValue(options.order)}`,
        );
      }
      order = options.order;
    }
    if (options.limit !== undefined) {
      if (typeof options.limit !== 'number' || !Number.isSafeInteger(options.limit) || options.limit < 1) {
        throw new ValidationError(
          `findMany() options.limit must be a positive integer, received ${describeValue(options.limit)}`,
        );
      }
    }
    if (options.offset !== undefined) {
      if (options.limit === undefined) {
        throw new ValidationError(
          'findMany() options.offset requires options.limit (SQLite OFFSET requires LIMIT)',
        );
      }
      if (typeof options.offset !== 'number' || !Number.isSafeInteger(options.offset) || options.offset < 0) {
        throw new ValidationError(
          `findMany() options.offset must be a non-negative integer, received ${describeValue(options.offset)}`,
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
        throw new ValidationError(`Model "${this.name}" has no TEXT fields to search in ${context}`);
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
          `Field "${field}" of model "${this.name}" is ${type}; only TEXT fields can be searched in ${context}`,
        );
      }
      if (seen.has(field)) {
        throw new ValidationError(`Duplicate field "${field}" in ${context} fields`);
      }
      seen.add(field);
    }
    if (seen.size === 0) {
      throw new ValidationError(`${context} fields must contain at least one TEXT field name`);
    }
    return [...seen];
  }

  /** 校验 count 的可选关键字过滤选项。 */
  private validateCountOptions(options: CountOptions<F> | undefined): CountOptions<F> {
    if (options === undefined) return {};
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `count() options must be an object with keyword/fields or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== 'keyword' && key !== 'fields') {
        throw new ValidationError(`Unknown option "${key}" in count() options`);
      }
    }
    return options;
  }

  private unknownFieldError(field: string, context: string): ValidationError {
    const reserved = reservedFieldName(field);
    if (reserved !== null) {
      return new ValidationError(
        `Field "${reserved}" is managed automatically and cannot be passed to ${context} of model "${this.name}"`,
      );
    }
    return new ValidationError(`Model "${this.name}" has no field "${field}"`);
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
