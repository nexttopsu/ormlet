import type { SQLOutputValue, SQLInputValue } from 'node:sqlite';
import type { Database } from './database.js';
import { InvalidModelError, SqlModelError, TransactionError, ValidationError } from './errors.js';
import { translateSqliteError, isReadOnlyDatabaseError } from './sql-error.js';
import type {
  CountOptions,
  CreateManyOptions,
  FieldType,
  ModelData,
  ModelDataTuple,
  ModelDefinition,
  ModelFields,
  ModelRow,
  MutationResult,
  QueryOptions,
  SearchOptions,
  UpdateManyOptions,
  UpsertOptions,
  WhereInput,
} from './types.js';
import {
  CREATED_AT,
  FIELD_TYPES,
  MANAGED_COLUMNS,
  PRIMARY_KEY,
  UPDATED_AT,
  assertChunkSize,
  assertFieldValue,
  assertId,
  assertIdentifier,
  assertTimestampValue,
  describeValue,
  isTimestampField,
  reservedFieldName,
  toSafeInteger,
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

  /** 模型名（注册时使用的名称） */
  readonly name: string;
  /** 绑定的数据表名 */
  readonly tableName: string;

  constructor(database: Database, name: string, definition: ModelDefinition<F>) {
    assertIdentifier(name, 'model name');
    if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new InvalidModelError(
        `Model definition must be an object with "tableName" and "fields", received ${describeValue(definition)}`,
      );
    }
    const { tableName, fields } = definition;
    if (tableName === undefined || fields === undefined) {
      throw new InvalidModelError('Model definition requires both "tableName" and "fields"');
    }
    assertIdentifier(tableName, 'table name');
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new InvalidModelError(
        `Model fields must be an object mapping field names to field types, received ${describeValue(fields)}`,
      );
    }
    const fieldEntries = Object.entries(fields);
    if (fieldEntries.length === 0) {
      throw new InvalidModelError('Model must declare at least one field');
    }
    for (const [fieldName, fieldType] of fieldEntries) {
      assertIdentifier(fieldName, 'field name');
      const reserved = reservedFieldName(fieldName);
      if (reserved !== null) {
        throw new InvalidModelError(
          `A declared field is reserved: "${reserved}" is managed automatically and cannot be declared on a model`,
        );
      }
      if (typeof fieldType !== 'string' || !FIELD_TYPES.has(fieldType)) {
        throw new InvalidModelError(
          `Invalid field type: expected one of ${[...FIELD_TYPES].join(', ')}, received ${describeValue(fieldType)}`,
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
    const result = this.execute('create()', (db) => db.prepare(sql).run(...entryValues(entries)));
    const id = toSafeInteger(result.lastInsertRowid);
    const row = this.selectById(id);
    if (row === undefined) {
      throw new SqlModelError(`Inserted row (id = ${id}) could not be read back from the table`);
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
   * 条件查询，多个字段之间为 AND 关系；
   * 不传条件时返回全部记录，默认按 `id` 降序排列。
   * options 可指定排序字段、方向与分页（limit / offset）。
   *
   * `where` 的值既可以是标量（等值），也可以是操作符对象：
   * `{ age: { gte: 18 } }`、`{ status: { in: ['a', 'b'] } }`、
   * `{ deletedAt: { isNull: true } }`、`{ createdAt: { gte: '2026-01-01T00:00:00.000Z' } }`。
   * `createdAt` / `updatedAt` 不可写入，但**可以**作为查询条件。
   */
  findMany(where?: WhereInput<F>, options?: QueryOptions<F>): ModelRow<F>[] {
    const conditions = this.validateWhere(where, 'findMany()');
    const { orderBy, order, limit, offset } = this.validateOptions(options);
    const params = conditionParams(conditions);
    let sql = `SELECT * FROM "${this.tableName}"`;
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
        .prepare(sql)
        .all(...params)
        .map((raw) => this.toRow(raw)),
    );
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
    return this.execute('findMany()', (db) =>
      db
        .prepare(sql)
        .all(...params)
        .map((raw) => this.toRow(raw)),
    );
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
    const result = this.execute('update()', (db) =>
      db.prepare(sql).run(...entryValues(entries), safeId),
    );
    return toSafeInteger(result.changes) > 0;
  }

  /**
   * 按 id 删除一条记录，返回是否有记录被删除。
   */
  delete(id: number): boolean {
    const safeId = assertId(id);
    const result = this.execute('delete()', (db) =>
      db.prepare(`DELETE FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" = ?`).run(safeId),
    );
    return toSafeInteger(result.changes) > 0;
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
   * - 空数组返回空数组，不执行任何语句。
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
        const result = this.execute('createMany()', (db) => db.prepare(sql).run(...params));
        // 多行 VALUES 的 lastInsertRowid 是最后一行，且同一语句内的 id 连续
        const last = toSafeInteger(result.lastInsertRowid);
        for (let i = batch.length - 1; i >= 0; i--) ids.push(last - i);
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
    const params: SQLInputValue[] = fields.map((field) => {
      if (byField.has(field)) return byField.get(field) as SQLInputValue;
      return (updateEntries.find(([name]) => name === field)?.[1] ?? null) as SQLInputValue;
    });
    params.push(now, now);
    const columns = [...fields, CREATED_AT, UPDATED_AT].map((field) => `"${field}"`).join(', ');
    const placeholders = fields.map(() => '?').join(', ');
    return this.execute('upsert()', (db) => {
      if (assignable.length === 0) {
        // DO NOTHING 不返回行：先尝试插入并探测是否真的插入了
        const inserted = db
          .prepare(
            `INSERT INTO "${this.tableName}" (${columns}) VALUES (${placeholders}, ?, ?) ` +
              `${conflict}DO NOTHING RETURNING "${PRIMARY_KEY}" AS id`,
          )
          .get(...params);
        if (inserted !== undefined) {
          const row = this.selectById(toSafeInteger(inserted.id as number | bigint));
          if (row === undefined) throw new SqlModelError('The upserted row could not be read back from the table');
          return row;
        }
        const existing = db
          .prepare(
            `SELECT "${PRIMARY_KEY}" AS id FROM "${this.tableName}" ` +
              `WHERE ${target.map((field) => `"${field}" = ?`).join(' AND ')} LIMIT 1`,
          )
          .get(...target.map((field) => (byField.get(field) ?? null) as SQLInputValue));
        if (existing === undefined) {
          throw new SqlModelError('The conflicting row could not be located after upsert');
        }
        const row = this.selectById(toSafeInteger(existing.id as number | bigint));
        if (row === undefined) throw new SqlModelError('The upserted row could not be read back from the table');
        return row;
      }
      const updated = db
        .prepare(
          `INSERT INTO "${this.tableName}" (${columns}) VALUES (${placeholders}, ?, ?) ` +
            `${conflict}${updateSql} RETURNING "${PRIMARY_KEY}" AS id`,
        )
        .get(...params);
      if (updated === undefined) {
        throw new SqlModelError('The upserted row could not be read back from the table');
      }
      const row = this.selectById(toSafeInteger(updated.id as number | bigint));
      if (row === undefined) throw new SqlModelError('The upserted row could not be read back from the table');
      return row;
    });
  }

  /**
   * 批量插入或更新，返回语句实际影响的行数。
   *
   * - 冲突判定与更新规则同 `upsert()`，整个批次在一个事务内完成；
   * - 每行逐条执行（不使用多行 VALUES），因此各行字段集合可以不同，缺失字段写入 NULL；
   * - 不逐行回读，只返回影响行数（插入与更新都计 1）。
   */
  upsertMany(rows: ModelDataTuple<F>, options?: UpsertOptions<F>): number {
    if (rows.length === 0) return 0;
    if (!Array.isArray(rows)) {
      throw new ValidationError(`upsertMany() expects an array of objects, received ${describeValue(rows)}`);
    }
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
        const result = this.execute('upsertMany()', (db) => db.prepare(sql).run(...params));
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
          .prepare(`SELECT "${PRIMARY_KEY}" AS id FROM "${this.tableName}" WHERE ${whereSql} ORDER BY "${PRIMARY_KEY}"`)
          .all(...whereParams)
          .map((row) => toSafeInteger(row.id as number | bigint)),
      );
      for (let start = 0; start < ids.length; start += chunkSize) {
        const batch = ids.slice(start, start + chunkSize);
        const sql =
          `UPDATE "${this.tableName}" SET ${setSql}, "${UPDATED_AT}" = ? ` +
          `WHERE "${PRIMARY_KEY}" IN (${batch.map(() => '?').join(', ')})`;
        const result = this.execute('updateMany()', (db) =>
          db.prepare(sql).run(...setParams, now, ...batch),
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
   * - 不传条件会删除整张表的所有行（与 `findMany()` 不传条件返回全部行对称），
   *   因此调用方需要自己确认范围；这里不做额外的「必须带条件」限制；
   * - 内部按 `chunkSize` 分批，整体在一个事务中执行。
   */
  deleteMany(where?: WhereInput<F>, options?: UpdateManyOptions): MutationResult {
    const conditions = this.validateWhere(where, 'deleteMany()');
    const { chunkSize } = this.validateUpdateManyOptions(options);
    const whereSql = conditions.length > 0 ? conditions.map((c) => c.sql).join(' AND ') : '1 = 1';
    const whereParams = conditionParams(conditions);
    let changes = 0;
    let statements = 0;
    this.runInTransaction(() => {
      const ids = this.execute('deleteMany()', (db) =>
        db
          .prepare(`SELECT "${PRIMARY_KEY}" AS id FROM "${this.tableName}" WHERE ${whereSql} ORDER BY "${PRIMARY_KEY}"`)
          .all(...whereParams)
          .map((row) => toSafeInteger(row.id as number | bigint)),
      );
      for (let start = 0; start < ids.length; start += chunkSize) {
        const batch = ids.slice(start, start + chunkSize);
        const sql = `DELETE FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" IN (${batch.map(() => '?').join(', ')})`;
        const result = this.execute('deleteMany()', (db) => db.prepare(sql).run(...batch));
        changes += toSafeInteger(result.changes);
        statements += 1;
      }
    });
    return { changes, statements };
  }

  /**
   * 统计记录数量，支持与 findMany 一致的条件（等值与操作符），使用 SQL `COUNT(*)` 实现。
   * `options` 可附加关键字过滤（与 search 一致的 OR LIKE 语义），用于搜索结果的分页总数。
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
    let sql = `SELECT COUNT(*) AS total FROM "${this.tableName}"`;
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    const raw = this.execute('count()', (db) => db.prepare(sql).get(...params));
    const total = raw?.total;
    if (typeof total !== 'number' && typeof total !== 'bigint') {
      throw new SqlModelError('COUNT(*) did not return an integer');
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
        db.exec(`ALTER TABLE "${this.tableName}" ADD COLUMN "${field}" ${type}`),
      );
      added.push(field);
    }
    // 自动管理的时间戳列同样需要补齐（例如旧版本库或外部工具创建的表）
    for (const [field, type] of MANAGED_COLUMNS) {
      if (columns.has(field.toLowerCase())) continue;
      this.execute('syncFields()', (db) =>
        db.exec(`ALTER TABLE "${this.tableName}" ADD COLUMN "${field}" ${type}`),
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
      db.exec(`ALTER TABLE "${this.tableName}" DROP COLUMN "${field}"`),
    );
    return true;
  }

  private selectById(id: number): ModelRow<F> | undefined {
    const raw = this.execute('findById()', (db) =>
      db.prepare(`SELECT * FROM "${this.tableName}" WHERE "${PRIMARY_KEY}" = ?`).get(id),
    );
    return raw === undefined ? undefined : this.toRow(raw);
  }

  /** 通过 pragma_table_info 表值函数查询当前表的实际列名（表名走参数绑定）。 */
  private getTableColumns(): string[] {
    return this.execute('Reading table columns', (db) =>
      db
        .prepare('SELECT name FROM pragma_table_info(?)')
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
   * - 字段必须在模型白名单内；`createdAt` / `updatedAt` 只读，但允许作为条件；
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
      const timestamp = isTimestampField(field);
      const type = this.fieldTypes.get(field);
      if (!timestamp && type === undefined) {
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
        this.assertConditionValue(field, type, condition, timestamp, `${context} conditions`);
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
          ...this.buildOperator(field, type, operator, value, timestamp, `${context} conditions`),
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
    type: FieldType | undefined,
    operator: string,
    value: unknown,
    timestamp: boolean,
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
        this.assertConditionValue(field, type, item, timestamp, `${context} "in" lists`);
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
        this.assertConditionValue(field, type, item, timestamp, `${context} "between" bounds`);
      }
      return { sql: `"${field}" BETWEEN ? AND ?`, params: value as SQLInputValue[] };
    }
    if (value === null || value === undefined) {
      throw new ValidationError(
        `${context} "${operator}" requires a non-null value; use { isNull: true } to match NULL values`,
      );
    }
    this.assertConditionValue(field, type, value, timestamp, context);
    return { sql: `"${field}" ${COMPARISON_SQL[operator]} ?`, params: [value as SQLInputValue] };
  }

  /** 校验条件里的单个值：时间戳列只接受字符串，其余按字段类型校验。 */
  private assertConditionValue(
    _field: string,
    type: FieldType | undefined,
    value: unknown,
    timestamp: boolean,
    context: string,
  ): void {
    if (timestamp) {
      assertTimestampValue(value);
      return;
    }
    if (type === undefined) {
      throw new ValidationError(`${context} reference an unknown field`);
    }
    assertFieldValue(type, value);
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
  private validateUpdateManyOptions(options: UpdateManyOptions | undefined): { chunkSize: number } {
    if (options === undefined) return { chunkSize: DEFAULT_MUTATION_CHUNK };
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new ValidationError(
        `options must be an object with chunkSize or undefined, received ${describeValue(options)}`,
      );
    }
    for (const key of Object.keys(options)) {
      if (key !== 'chunkSize') {
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
          `${context} options.orderBy must be a field declared on the model (or "${PRIMARY_KEY}"), received ${describeValue(field)}`,
        );
      }
      // 主键不在 fieldTypes 里（它是自动管理的列），但按主键排序是最常见的分页用法，需单独放行
      if (field !== PRIMARY_KEY && this.fieldTypes.get(field) === undefined) {
        throw this.unknownFieldError(field, `${context} options.orderBy`);
      }
      orderBy = field;
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
