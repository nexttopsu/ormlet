# ormlet

基于 Node.js 内置 `node:sqlite` 模块的轻量级、类型安全的数据模型封装库。

定义一次数据模型，即可直接完成增删改查，无需在业务代码中反复编写 SQL。
**零第三方运行时依赖**（不依赖 `sqlite3`、`better-sqlite3`、TypeORM、Prisma 等），构建产物只引用 `node:sqlite`。

```typescript
import { Database } from 'ormlet';

const db = new Database('./data.db');

const User = db.model('User', {
  tableName: 'users',
  fields: {
    name: 'TEXT',
    age: 'INTEGER',
    email: 'TEXT',
  },
});

const user = User.create({ name: '张三', age: 25, email: 'zhangsan@example.com' });
const users = User.findMany({ age: 25 });
const one = User.findById(1);
User.update(1, { age: 26 });
User.delete(1);

db.close();
```

## 特性

- **零运行时依赖**：仅使用 Node.js 内置的 `node:sqlite`（`DatabaseSync`），无原生编译、无 postinstall。
- **类型安全**：根据 `fields` 自动推导字段名和值类型，未知字段、错误值类型在编译期即可发现；运行时同样做白名单校验。
- **防注入设计**：表名 / 字段名经过标识符白名单校验后才拼接 SQL，所有数据值一律通过预编译语句参数绑定。
- **自动建表**：注册模型时自动创建不存在的表（自增 `id` 主键 + `STRICT` 严格类型模式），并自动补齐表中缺失的模型字段。
- **自动时间戳**：每张表自动维护 `createdAt` / `updatedAt`（ISO 8601 UTC），创建时写入、修改时自动刷新，不可手动修改或删除。
- **排序与分页**：`findMany` 支持 `orderBy` / `order` 自定义排序与 `limit` / `offset` 分页，配合 `count()` 即可组装分页元信息。
- **关键字搜索**：`search()` 对 TEXT 字段做 OR LIKE 子串匹配（ASCII 大小写不敏感），支持指定字段与排序分页；`count()` 可带关键字统计搜索总数。
- **字段同步与删除**：模型新增字段后重新打开数据库即自动补列（`syncFields`）；多余的列可手动删除（`deleteField`，仅允许删除模型未声明的字段，防止误删）。
- **共享连接**：一个 `Database` 实例统一管理连接，多个模型共享，`close()` 后所有操作明确报错。
- **双格式产物**：同时发布 ESM（`.mjs`）和 CJS（`.cjs`），附带完整的 `.d.ts` / `.d.mts` 类型声明。

## 环境要求（重要）

本库依赖 Node.js 内置的 `node:sqlite` 模块，各版本可用性如下：

| Node.js 版本 | `node:sqlite` 状态 | 是否可用 |
| --- | --- | --- |
| < 22.5.0 | 模块不存在 | 不可用 |
| 22.5.0 – 22.12.x | 实验性，需 `--experimental-sqlite` 启动参数 | 可用（需加 flag） |
| 22.13.0 – 24.14.x | 实验性，无需 flag，运行时输出 `ExperimentalWarning` | 可用 |
| 24.15.0+ / 25.7.0+ | Release Candidate，无警告 | 可用 |

- `package.json` 中已声明 `"engines": { "node": ">=22.5.0" }`。
- 在 22.5.0 – 22.12.x 上使用时需要启动参数：`node --experimental-sqlite app.js`。
- 在 22.13.0+ 上运行时会在 stderr 输出一次 `ExperimentalWarning: SQLite is an experimental feature...`，属正常现象；如需静默可加 `--no-warnings`。
- 官方文档参考：[node:sqlite | Node.js Docs](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)。

## 安装

```bash
npm install ormlet
```

本地开发：

```bash
npm install
npm run build        # 构建产物到 dist/
npm test             # TypeScript 编译检查 + 全部测试
npm run dev          # 运行示例 example.ts
```

## 快速开始

```typescript
import { Database } from 'ormlet';

// ':memory:' 创建内存数据库；传文件路径则打开或自动创建文件数据库
const db = new Database(':memory:');

// 注册模型：校验定义并自动建表，返回可直接 CRUD 的模型实例
const User = db.model('User', {
  tableName: 'users',
  fields: {
    name: 'TEXT',
    age: 'INTEGER',
    email: 'TEXT',
    score: 'REAL',
    avatar: 'BLOB',
  },
});

// 新增：返回包含自动生成 id、自动时间戳的完整记录，未提供的字段为 null
const user = User.create({ name: '张三', age: 25 });
// => { id: 1, createdAt: '2026-10-15T08:30:00.000Z', updatedAt: '2026-10-15T08:30:00.000Z',
//      name: '张三', age: 25, email: null, score: null, avatar: null }

// 查询
User.findById(1);                 // 单条，不存在返回 undefined
User.findMany();                  // 全部记录，默认按 id 降序
User.findMany({ age: 25 });       // 等值过滤，多字段之间为 AND
User.findMany(undefined, {        // 自定义排序 + 分页
  orderBy: 'age',
  order: 'ASC',
  limit: 10,
  offset: 20,
});
User.search('张三');                          // 关键字搜索全部 TEXT 字段
User.search('张三', { fields: ['name'] });    // 只搜 name，支持排序分页
User.count();                     // SELECT COUNT(*)
User.count({ age: 25 });          // 带过滤的计数
User.count(undefined, { keyword: '张三' });   // 搜索结果总数

// 修改：只更新传入的字段，返回是否有记录被修改
User.update(user.id, { age: 26 });   // => true
User.update(999, { age: 26 });       // => false（记录不存在）

// 删除：返回是否有记录被删除
User.delete(user.id);             // => true
User.delete(user.id);             // => false

// 关闭数据库：可安全重复调用，关闭后任何操作都会抛 DatabaseClosedError
db.close();
```

## API

### `class Database`

#### `new Database(path)`

打开（或创建）一个 SQLite 数据库。

- `path: string` — 数据库文件路径，不存在时自动创建；传 `':memory:'` 使用内存数据库。
- 连接由 `Database` 实例统一持有，禁止模型各自创建连接。
- 路径非法（非字符串或空字符串）时抛出 `ValidationError`。

#### `db.model(name, definition)`

注册并创建一个模型，返回 `Model` 实例。

- `name: string` — 模型名，同一 `Database` 实例内必须唯一，重复注册抛 `InvalidModelError`。
- `definition` — 模型定义：
  - `tableName: string` — 表名，必须是合法 SQL 标识符（`/^[A-Za-z_][A-Za-z0-9_]*$/`），且不能与其他模型重复；
  - `fields: Record<string, FieldType>` — 字段声明，字段名同样是合法标识符，且不能是保留的 `id`、`createdAt`、`updatedAt`。
- 创建时完成全部校验（非法表名 / 字段名 / 字段类型都会抛 `InvalidModelError`），并自动建表：

  ```sql
  CREATE TABLE IF NOT EXISTS "users" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "createdAt" TEXT,
    "updatedAt" TEXT,
    "name" TEXT,
    "age" INTEGER
  ) STRICT
  ```

- `STRICT` 模式让 SQLite 在存储层也强制列类型，与 JS 侧校验形成双重防护。
- 如果表已存在但缺少模型声明的字段，注册时会自动补齐（见 [`syncFields()`](#syncfields)）。

#### `db.close()`

关闭数据库连接。可安全重复调用；关闭后所有模型操作抛出 `DatabaseClosedError`。

#### `db.isOpen`

数据库是否处于打开状态。

### `class Model<F>`

`db.model()` 的返回值，泛型 `F` 为字段定义，自动推导字段名和值类型。

#### `create(data): ModelRow<F>`

插入一条记录，返回包含自动生成 `id` 的完整行。

- 只接受模型已声明的字段；未提供的字段存储为 `NULL`，显式传 `null` 也可以。
- `createdAt` / `updatedAt` 自动写入当前时间，不可通过参数指定。
- 空对象（或全部为 `undefined`）抛 `ValidationError`，不会生成无效 SQL。
- 未知字段、值类型不匹配抛 `ValidationError`。

#### `findById(id): ModelRow<F> | undefined`

按自增主键查询单条记录；不存在返回 `undefined`。`id` 必须是正的安全整数。

#### `findMany(where?, options?): ModelRow<F>[]`

等值条件查询，返回数组（无匹配返回空数组）。

- 不传条件（或传空对象）时查询全部记录；
- 多个字段之间为 AND 关系；
- 默认按 `id` 降序（`ORDER BY "id" DESC`）；
- 不允许传入任意 SQL；条件中的 `null` 会被拒绝（SQL 中 `column = NULL` 永远不成立，属常见误用）。

`options` 排序与分页选项（全部可选，字段名和类型错误在编译期即可发现）：

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `orderBy` | 模型声明的字段名 | 排序字段，默认 `id`；保留字段（`id` / `createdAt` / `updatedAt`）不允许 |
| `order` | `'ASC' \| 'DESC'` | 排序方向，默认 `DESC` |
| `limit` | `number` | 返回的最大记录数，必须是正整数 |
| `offset` | `number` | 跳过的记录数，必须是非负整数，且必须与 `limit` 一起使用 |

```typescript
// 按年龄升序取第 3 页（每页 10 条）
const page = 3;
const pageSize = 10;
const users = User.findMany(undefined, {
  orderBy: 'age',
  order: 'ASC',
  limit: pageSize,
  offset: (page - 1) * pageSize,
});

// 配合 count() 组装分页元信息
const total = User.count();
const totalPages = Math.ceil(total / pageSize);
```

非法选项都会抛 `ValidationError`：未知排序字段（含注入尝试）、非法方向（如 `'asc'`、`'RANDOM()'`）、非正整数 `limit`、无 `limit` 的 `offset`，以及未知选项键（如把 `limit` 拼写错——避免被静默忽略后意外加载全表）。`limit` / `offset` 同样通过参数绑定传入。

#### `search(keyword, options?): ModelRow<F>[]`

关键字搜索：对 TEXT 字段做子串匹配（`LIKE '%keyword%'`），任意字段命中即返回（OR 语义）。

- `keyword: string` — 非空字符串；SQLite 的 `LIKE` 对 ASCII 大小写不敏感（`zhang` 可命中 `Zhang`），中文不受影响；
- `%` 与 `_` 作为 LIKE 通配符原样生效（如 `张_` 匹配"张三"）；需要匹配字面量 `%` / `_` 时请自行转义（`\%`、`\_`）；
- `options.fields` — 参与搜索的 TEXT 字段数组（编译期即限定为 TEXT 字段名），缺省为模型声明的全部 TEXT 字段；
- `options` 其余选项与 `findMany` 完全一致（`orderBy` / `order` / `limit` / `offset`）；
- 关键字（含 `%` 包裹）整体作为参数绑定值传入，不拼接 SQL；
- 模型没有 TEXT 字段、或传入非法字段（未知字段、非 TEXT 类型、重复、空数组）时抛 `ValidationError`。

```typescript
// 搜索 + 排序 + 分页 + 总数
const users = User.search('张三', {
  fields: ['name', 'email'],
  orderBy: 'name',
  order: 'ASC',
  limit: 10,
  offset: 0,
});
const total = User.count(undefined, { keyword: '张三', fields: ['name', 'email'] });
```

#### `count(where?, options?): number`

返回记录数量，支持与 `findMany` 一致的等值过滤，使用 SQL `COUNT(*)` 实现。

`options` 可选关键字过滤（用于搜索结果的分页总数）：

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `keyword` | `string` | 对 `fields` 的 TEXT 字段做 OR LIKE 匹配（语义同 `search`），与 `where` 等值条件为 AND 关系 |
| `fields` | TEXT 字段名数组 | 参与关键字搜索的字段，缺省为全部 TEXT 字段；必须与 `keyword` 一起使用 |

#### `update(id, data): boolean`

按 `id` 更新记录，只更新传入的字段。返回是否有记录被修改；记录不存在返回 `false`。

- `updatedAt` 自动刷新为当前时间；
- 拒绝空更新对象；
- 不允许修改主键 `id`；
- 字段和值分别校验（未知字段 / 类型不匹配抛 `ValidationError`）。

#### `delete(id): boolean`

按 `id` 删除一条记录，返回是否有记录被删除。

#### `syncFields(): string[]`

将模型声明的字段同步到数据表：表中缺失的字段自动补建（`ALTER TABLE ... ADD COLUMN`，已存在的行该列为 NULL）。

- 只做存在性检查：已存在的字段不做类型核对，也不重命名；
- 表中存在但模型未声明的多余列不受影响；
- 自动管理的时间戳列（`createdAt` / `updatedAt`）缺失时同样补齐；
- 模型注册时会自动执行一次，因此**修改模型字段后重新打开数据库即可完成增量迁移**；
- 重复调用幂等；返回本次新增的字段名数组（含自动补齐的时间戳列）。

```typescript
// 模型新增了 nickname 字段，重新打开数据库时自动补齐
const db = new Database('./data.db');
const User = db.model('User', {
  tableName: 'users',
  fields: { name: 'TEXT', nickname: 'TEXT' },
});

// 也可以手动调用（例如其他连接修改了表结构之后）
User.syncFields(); // => []（已同步时）
```

#### `deleteField(field): boolean`

删除数据表中一个**模型未声明**的字段（`ALTER TABLE ... DROP COLUMN`）。需要用户显式调用。

- 为避免误删，主键 `id` 和模型声明的字段都会被拒绝（抛 `ValidationError`，大小写不敏感）；
- 字段不存在时返回 `false`，删除成功返回 `true`；
- 字段名同样只接受合法标识符。

典型工作流：从模型定义中移除字段 → 表中该列成为多余列 → 确认不再需要后手动删除：

```typescript
// 模型中已移除 age 字段，但表里的 age 列仍在
User.deleteField('age'); // => true
User.deleteField('age'); // => false（列已不存在）

User.deleteField('name'); // 抛 ValidationError：name 是模型声明的字段
User.deleteField('id');   // 抛 ValidationError：id 是主键
User.deleteField('createdAt'); // 抛 ValidationError：自动管理的时间戳字段
```

> `DROP COLUMN` 需要 SQLite ≥ 3.35.0；Node.js 22.5+ 内置的 SQLite 版本均满足。

#### 自动时间戳字段

每张表都会自动维护两个时间戳字段（TEXT 存储，ISO 8601 UTC 字符串，毫秒精度）：

| 字段 | 行为 |
| --- | --- |
| `createdAt` | `create()` 时自动写入当前时间，之后永不变化 |
| `updatedAt` | `create()` 时自动写入当前时间，每次 `update()` 自动刷新 |

```typescript
const user = User.create({ name: '张三', age: 25 });
// user.createdAt === user.updatedAt（同一创建时刻）

User.update(user.id, { age: 26 });
const updated = User.findById(user.id);
// updated.createdAt 不变；updated.updatedAt 已刷新为修改时刻
```

这两个字段与主键 `id` 一样是保留的自动管理字段：

- 不能在模型 `fields` 中声明（抛 `InvalidModelError`）；
- 不能通过 `create()` / `update()` 传入，也不能作为 `findMany()` / `count()` 的查询条件（抛 `ValidationError`）；
- 不能通过 `deleteField()` 删除（抛 `ValidationError`）。

对于旧版本库（或外部工具）创建的、没有时间戳列的表：注册模型时会自动补齐这两列（`syncFields()` 同样会补齐），已有行的值保持 `NULL`；该行下次 `update()` 时 `updatedAt` 会被写入，而 `createdAt` 保持 `NULL`（原始创建时间已不可知）。

### 类型

| 导出类型 | 说明 |
| --- | --- |
| `FieldType` | `'TEXT' \| 'INTEGER' \| 'REAL' \| 'BLOB'`，字段类型白名单 |
| `FieldValue<T>` | 字段类型 → TS 值类型映射 |
| `ModelFields` | `Record<string, FieldType>`，字段定义 |
| `ModelDefinition<F>` | `{ tableName: string; fields: F }` |
| `ModelRow<F>` | 查询结果 / `create` 返回的行类型：自动字段（`id`、`createdAt`、`updatedAt`）+ 各模型字段（未赋值为 `null`） |
| `ModelData<F>` | 写入 / 查询条件类型：字段全部可选，允许 `null` |
| `QueryOptions<F>` | `findMany` 的排序与分页选项：`orderBy` / `order` / `limit` / `offset` |
| `SearchOptions<F>` | `search` 的选项：`fields`（参与搜索的 TEXT 字段）+ `QueryOptions` |
| `CountOptions<F>` | `count` 的关键字过滤选项：`keyword` / `fields` |
| `TextFieldNames<F>` | 模型中 TEXT 字段的字段名联合类型 |

字段类型与 TypeScript 值类型的对应关系：

| SQLite 类型 | TypeScript 类型 |
| --- | --- |
| `TEXT` | `string` |
| `INTEGER` | `number`（要求安全整数） |
| `REAL` | `number`（有限数值） |
| `BLOB` | `Uint8Array` |

以下错误在编译期即可被 TypeScript 发现：

```typescript
User.create({ name: 123 });          // 错误：TEXT 字段需要 string
User.create({ unknownField: 'x' });  // 错误：未知字段
User.update(1, { age: '二十五岁' });  // 错误：INTEGER 字段需要 number
User.update(1, { id: 2 });           // 错误：不允许修改主键
User.findMany({ age: '25' });        // 错误：查询条件类型不匹配
```

### 错误类型

所有错误继承自 `SqlModelError`，均包含明确的英文错误信息（不含敏感信息）：

| 错误类 | 触发场景 |
| --- | --- |
| `SqlModelError` | 基类；SQLite 返回超出安全整数范围的数值等内部异常 |
| `DatabaseClosedError` | 数据库关闭后继续操作 |
| `InvalidModelError` | 模型定义非法：表名 / 字段名 / 字段类型不合法，模型名或表名重复 |
| `ValidationError` | CRUD 参数非法：未知字段、值类型不匹配、空数据、非法 id、查询条件传 null 等 |

## 安全设计

1. **标识符白名单**：表名、字段名、模型名必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`，校验通过后才拼接 SQL，并统一使用双引号包裹。
2. **字段白名单贯穿所有写路径**：新增、更新、查询条件、计数的字段都来自模型声明，`id`、`createdAt`、`updatedAt` 为保留的自动管理字段，不可声明、不可写入、不可删除。
3. **参数绑定**：所有业务数据值一律通过 `DatabaseSync.prepare()` 预编译语句的参数绑定传入，不存在用户输入拼接进 SQL 值位置的路径。
4. **双重类型防护**：JS 侧校验值类型（INTEGER 限定安全整数、REAL 限定有限数值），建表使用 SQLite `STRICT` 模式在存储层再次强制。
5. **不开启危险扩展**：不启用 `allowExtension`（SQLite 扩展加载）、`enableDoubleQuotedStringLiterals` 等可能降低安全性的选项。
6. **无敏感信息泄露**：错误信息只包含参数的类型描述，不输出文件内容等敏感信息；本项目不涉及数据库密码。

## 资源与错误处理

- `db.close()` 关闭连接，可安全重复调用；关闭后操作抛 `DatabaseClosedError`，不会静默失败。
- CRUD 不会反复创建 / 关闭连接，全部复用 `Database` 持有的唯一连接。
- SQLite 异常（如磁盘错误、约束冲突）正常向上抛出，不会静默吞掉。
- 对 `node:sqlite` 返回的 `number | bigint` 做了统一收敛：超长整数在读取时会明确报错，`id`、`changes`、`COUNT(*)` 一律以安全整数 `number` 返回。

## 开发

```bash
npm run typecheck   # TypeScript 编译检查（含 tests/type-check.ts 编译期断言）
npm test            # 编译检查 + 全部单元测试（node:test，无需新增依赖）
npm run build       # tsup 构建 dist/（CJS + ESM + 类型声明）
npm run dev         # 运行 example.ts 基础示例
```

测试覆盖：内存数据库、自动建表、全部 CRUD、条件查询、排序与分页、关键字搜索（大小写、字段限制、通配符、注入防护）、参数绑定与特殊字符、多模型共享连接、文件持久化、字段同步与删除、自动时间戳（含旧表迁移）、关闭后拒绝操作、非法参数拒绝、编译期类型检查等 79 个用例，全部可重复运行，不污染任何已有数据库文件。

## 暂未实现（第一版范围外）

- 表关联与 JOIN 查询
- 复杂的 WHERE 条件构造器（范围、OR、LIKE 等）
- 完整的数据库迁移（字段重命名、类型修改、索引与约束管理等；目前仅支持新增字段的自动补齐和多余字段的手动删除）
- 关系映射与懒加载
- 事件系统、插件系统、缓存机制
- Web 管理界面、生命周期钩子、CRUD 代码生成器

## License

ISC
