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

## 目录

- [适用与不适用](#适用与不适用)
- [特性](#特性)
- [环境要求（重要）](#环境要求重要)
- [安装](#安装)
- [快速开始](#快速开始)
- [API](#api)
  - [`class Database`](#class-database)
  - [`class Model<F>`](#class-modelf)
  - [托管字段](#托管字段id--createdat--updatedat)
- [类型](#类型)
- [值类型与 NULL 语义](#值类型与-null-语义)
- [错误类型](#错误类型)
- [常见错误速查](#常见错误速查)
- [安全设计](#安全设计)
- [并发与事务实践](#并发与事务实践)
- [性能与实践](#性能与实践)
- [迁移与版本管理](#迁移与版本管理)
- [资源与错误处理](#资源与错误处理)
- [从 1.x 升级](#从-1x-升级)
- [开发](#开发)
- [暂未实现](#暂未实现第一版范围外)
  - [外键行为](#外键行为)
  - [没有索引声明能力时怎么建索引](#没有索引声明能力时怎么建索引)

## 适用与不适用

这个库的定位很具体，先确认场景再往下读。

**适合**：

- 桌面应用、CLI 工具、本地优先（local-first）应用——数据在本地文件里，进程独占或少量进程；
- 单机服务、边缘节点、内部工具的持久层：并发量不高，但要求部署简单、没有原生编译；
- 测试替身：`new Database(':memory:')` 秒级建库，不需要 mock 或容器；
- 需要一个「有类型、写起来像 ORM」的薄封装，但不想引入 ORM 的迁移体系与运行时。

**不适合**：

- 高并发写入（每秒上千事务以上）——SQLite 单写者模型本身就不适配，请用 PostgreSQL / MySQL；
- 需要跨机器共享数据库文件——文件锁在 NFS / 云同步盘上不可靠，会静默损坏数据；
- 需要 JOIN、复杂 OR 条件、关系映射与懒加载——本库有意不提供（见[暂未实现](#暂未实现第一版范围外)）；
- 长事务 + 事件循环敏感的服务——所有 API 都是**同步**的，锁等待会阻塞事件循环（见[并发与事务实践](#并发与事务实践)）。

## 特性

- **零运行时依赖**：仅使用 Node.js 内置的 `node:sqlite`（`DatabaseSync`），无原生编译、无 postinstall。
- **类型安全**：根据 `fields` 自动推导字段名和值类型，未知字段、错误值类型在编译期即可发现；运行时同样做白名单校验。
- **防注入设计**：表名 / 字段名经过标识符白名单校验后才拼接 SQL，所有数据值一律通过预编译语句参数绑定。
- **自动建表**：注册模型时自动创建不存在的表（自增 `id` 主键 + `STRICT` 严格类型模式），并自动补齐表中缺失的模型字段。
- **自动时间戳**：每张表自动维护 `createdAt` / `updatedAt`（ISO 8601 UTC），创建时写入、修改时自动刷新，不可手动修改或删除。
- **条件查询**：等值 + 范围（`gt` / `gte` / `lt` / `lte`）、集合（`in`）、区间（`between`）、判空（`isNull`），编译期校验字段与值类型；托管列（`id` / `createdAt` / `updatedAt`）同样可作条件与排序字段。
- **单行读取**：`findOne()` 取首条、`exists()` 判存在（`SELECT 1 ... LIMIT 1`）、`findByIds()` 一次取回一批主键对应的行，不必为了拿一条而写 `findMany(...)[0]`。
- **事务与批量写入**：`db.transaction()` 提供 `BEGIN IMMEDIATE` 事务；`createMany` / `upsert` / `upsertMany` / `updateMany` / `deleteMany` 在一个事务内批量执行，比逐条写入快两个数量级。
- **写后返回与删除护栏**：`update()` 返回更新后的整行、`delete()` 返回被删除的行（可直接用于审计）；`deleteMany()` 拒绝无条件调用，清空整表必须显式用 `clear()`。
- **排序与分页**：`findMany` 支持 `orderBy` / `order` 自定义排序与 `limit` / `offset` 分页，配合 `count()` 即可组装分页元信息。
- **游标分页**：`findPage()` 用 `(orderBy, id)` 游标定位，深分页不退化（实测 5 万行时第 1251 页 OFFSET 80.5ms → 游标 7.4ms），翻页期间插入新行也不会重复或漏行。
- **字段投影**：`select` 只查询需要的列，避免 `SELECT *` 把 BLOB / 长 TEXT 一并读进内存，返回类型自动收窄。
- **约束错误细分**：唯一 / 主键 / NOT NULL / 外键 / CHECK 冲突分别抛 `UniqueConstraintError` 等具体类型，不必再匹配错误文本。
- **关键字搜索**：`search()` 对 TEXT 字段做 OR LIKE 子串匹配（ASCII 大小写不敏感），支持指定字段与排序分页；`count()` 可带关键字统计搜索总数。
- **字段同步与删除**：模型新增字段后重新打开数据库即自动补列（`syncFields`）；多余的列可手动删除（`deleteField`，仅允许删除模型未声明的字段，防止误删）。
- **共享连接**：一个 `Database` 实例统一管理连接，多个模型共享，`close()` 后所有操作明确报错。
- **幂等注册**：同名且定义一致的 `db.model()` 返回同一实例，各模块可各自声明模型而不必集中管理；定义不一致则直接报错。
- **双格式产物**：同时发布 ESM（`.mjs`）和 CJS（`.cjs`），附带完整的 `.d.ts` / `.d.mts` 类型声明。

## 环境要求（重要）

本库依赖 Node.js 内置的 `node:sqlite` 模块，各版本可用性如下：

| Node.js 版本 | `node:sqlite` 状态 | 是否可用 |
| --- | --- | --- |
| < 22.5.0 | 模块不存在 | 不可用 |
| 22.5.0 – 22.12.x | 实验性（Stability 1.1），需 `--experimental-sqlite` 启动参数 | 可用（需加 flag） |
| 22.13.0 起 | 实验性（Stability 1.1），**flag 已移除**，运行时输出 `ExperimentalWarning` | 可用 |
| 24.15.0 起 / 25.7.0 起 | Release Candidate（Stability 1.2），无警告 | 可用（推荐） |

> 上表按 Node.js 官方文档标注。RC 的具体起始版本在社区资料中存在 24.15.0 与 25.7.0 两种说法，
> 以你本地 `node -p "process.versions.node"` 与[官方文档](https://nodejs.org/api/sqlite.html)为准；
> 无论处于哪个阶段，本库用到的 API（`DatabaseSync` / `prepare` / `run` / `get` / `all` / `exec`）从 22.5.0 起就稳定存在。

- `package.json` 中已声明 `"engines": { "node": ">=22.5.0" }`。
- 在 22.5.0 – 22.12.x 上使用时需要启动参数：`node --experimental-sqlite app.js`。
- 在 22.13.0 – 24.14.x 上运行时会在 stderr 输出一次 `ExperimentalWarning: SQLite is an experimental feature...`，
  属正常现象；如需静默可加 `--no-warnings`。
- 官方文档参考：[node:sqlite | Node.js Docs](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)。

### 关于并发写入

本库默认设置 `PRAGMA busy_timeout = 5000`（瞬时锁冲突会等待重试）并默认启用 WAL 日志模式（读写互不阻塞），
两者都可通过 `new Database(path, { busyTimeout, journalMode })` 调整。
WAL 会额外产生 `-wal` / `-shm` 文件；数据库文件不要放在网络盘或云同步盘上，那里的文件锁不可靠。

多实例同时首次打开一个**刚创建的空库**时，SQLite 可能把某个连接判为只读
（`attempt to write a readonly database`，重试语句无效）。本库会识别该状态并自动重开连接恢复写入；
重开后还会实际探测一次写能力（`BEGIN IMMEDIATE` + `ROLLBACK`），若其他进程正处于切换日志模式的临界区
导致新连接仍不可写，会短暂退避后再次重开（最多 5 次，总退避约 50ms）。
因此并发首次启动不会出现部分实例建表失败——压力测试中 8 进程 × 多轮初始化均为 8/8 成功。

## 安装

```bash
npm install ormlet
```

本地开发：

```bash
npm install
npm run build        # 构建产物到 dist/
npm test             # TypeScript 编译检查 + 全部测试
npm run dev          # 运行示例 example.ts（覆盖全部 API，输出即速查表）
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
User.findByIds([3, 1, 2]);        // 按主键批量查询，结果与入参一一对应
User.findOne({ email: 'a@example.com' });   // 单条，不存在返回 undefined
User.exists({ email: 'a@example.com' });    // 是否存在（SELECT 1 ... LIMIT 1）
User.findMany();                  // 全部记录，默认按 id 降序
User.findMany({ age: 25 });       // 等值过滤，多字段之间为 AND
User.findMany({ id: { in: [1, 2, 3] } });   // 按主键集合查询
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

// 修改：只更新传入的字段，返回更新后的整行
User.update(user.id, { age: 26 });   // => 更新后的行
User.update(999, { age: 26 });       // => undefined（记录不存在）

// 删除：返回被删除的那一行
User.delete(user.id);             // => 删除前的行
User.delete(user.id);             // => undefined（已经删掉了）
User.deleteMany({ age: { lt: 18 } });   // 批量删除必须有条件
User.clear();                     // 清空整表（显式方法，避免误删）

// 关闭数据库：可安全重复调用，关闭后任何操作都会抛 DatabaseClosedError
db.close();
```

## API

### `class Database`

一个 `Database` 实例持有一个 SQLite 连接，所有模型共享它。**一个进程只应创建一个实例**。

#### `new Database(path, options?)`

打开（或创建）一个 SQLite 数据库。

- `path: string` — 数据库文件路径，不存在时自动创建；传 `':memory:'` 使用内存数据库。
- `options.busyTimeout?: number` — 遇到数据库锁（其他连接正在读写同一文件）时的等待重试时长，毫秒，默认 `5000`。
  超时仍拿不到锁才会抛出 `LockTimeoutError`；设为 `0` 表示不等待、立即报错。
  等待发生在同步 API 内部，会阻塞事件循环至多该时长。
- `options.journalMode?: 'WAL' | 'DELETE' | 'MEMORY'` — 日志模式，默认 `'WAL'`（文件库）。
  WAL 下写不阻塞读、读不阻塞写，显著降低 `database is locked` 概率；`'DELETE'` 是 SQLite 默认的回滚日志模式
  （读事务会阻塞写）；`'MEMORY'` 日志放内存，崩溃可能损坏数据库。`:memory:` 内存库忽略该选项。
  切换日志模式需要短暂的独占锁，若打开时恰好有其他连接持锁，会保持原有模式并发出
  `ORM_JOURNAL_MODE_NOT_APPLIED` 警告（不会导致打开失败），空闲时重新打开即可生效。
- 连接由 `Database` 实例统一持有，禁止模型各自创建连接。
- 路径非法（非字符串或空字符串）、或 `options` 含未知键 / 取值非法时抛出 `ValidationError`。

构造时实际执行的 PRAGMA 只有两条：`busy_timeout` 与 `journal_mode`。
外键约束（`PRAGMA foreign_keys`）由 `node:sqlite` 默认**开启**，本库不做修改，
因此手动用 `db.exec` 建的外键会真实生效，见[外键行为](#外键行为)。

#### `db.model(name, definition)`

注册并创建一个模型，返回 `Model` 实例。

- `name: string` — 模型名，同一 `Database` 实例内必须唯一（见下方幂等规则）。
- `definition` — 模型定义：
  - `tableName: string` — 表名，必须是合法 SQL 标识符（`/^[A-Za-z_][A-Za-z0-9_]*$/`），且不能与其他模型重复；
  - `fields: Record<string, FieldType>` — 字段声明，字段名同样是合法标识符，且不能是保留的 `id`、`createdAt`、`updatedAt`
    （大小写不敏感，`Id` / `CREATEDAT` 同样被拒绝）。
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

- 列的物理顺序固定为：`id` → `createdAt` → `updatedAt` → 声明顺序的模型字段。
- `STRICT` 模式让 SQLite 在存储层也强制列类型，与 JS 侧校验形成双重防护。
- 如果表已存在但缺少模型声明的字段，注册时会自动补齐（见 [`syncFields()`](#syncfields-string)）。

**幂等注册**：同名且 `tableName` / `fields` 完全一致的重复调用**返回同一个实例**，
所以各模块可以各自写 `db.model('User', { … })`，不必把模型集中到一处再导出：

```typescript
// a.ts
export const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
// b.ts —— 定义相同，拿到的是 a.ts 里那个实例
export const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT' } });
```

字段比较与书写顺序无关，`{ a, b }` 与 `{ b, a }` 视为同一份定义。
同名但定义不同（表名不同、或字段集合不同）会抛 `InvalidModelError` ——
这通常意味着两个模块对同一张表的认知已经漂移，宁可启动失败也不要带着不一致的 schema 跑下去。

关于模型实例的生命周期：

- **不同 `Database` 实例注册同名模型是允许的**（它们连的是不同文件，互不影响）；
- `db.close()` 之后模型对象仍存在，但所有方法都会抛 `DatabaseClosedError`；
- 注册时会执行 DDL（`CREATE TABLE` / `ALTER TABLE`），因此**应在启动阶段完成**，
  不要在高频请求路径里反复调用（命中幂等缓存时不执行 DDL，但仍有定义比较的开销）。
- `new Model(db, name, definition)` 虽然可以构造，但同样受唯一性约束：
  表名或模型名已被占用时抛 `InvalidModelError`，与 `db.model()` 一致。

#### `db.close()`

关闭数据库连接。可安全重复调用；关闭后所有模型操作抛出 `DatabaseClosedError`。

若关闭时存在未提交的事务，该事务会被**回滚**并发出 `ORM_CLOSE_WITH_OPEN_TRANSACTION` 警告，
而不是让写入静默生效或静默丢失。

正常情况下 SQLite 会自动回收 `-wal` / `-shm` 文件（压测验证：关闭后两者均为 0 字节）。

#### `db.transaction(fn)`

在一个写事务中执行 `fn`，返回其返回值。

```typescript
const total = db.transaction(() => {
  User.create({ name: '张三', age: 25 });
  User.update(1, { age: 26 });
  return User.count();
});
```

- 使用 `BEGIN IMMEDIATE`：立即取得写锁，避免「先读后写」升级锁失败导致的 `SQLITE_BUSY`；
- `fn` 正常返回后提交；抛出任何错误时回滚，并**原样抛出**该错误（不会被包装）；
- **不支持嵌套**：已处于事务中时抛 `TransactionError`，而不是用 `SAVEPOINT` 模拟；
- `fn` 必须是同步函数，内部不要调用 `close()`（会抛 `DatabaseClosedError` 并回滚）；
- 默认 `synchronous = FULL` 下每条写语句都是独立事务（一次 fsync），
  因此把多次写入放进一个事务通常带来**数量级**的吞吐提升。

#### `db.inTransaction` / `db.rollback()`

- `db.inTransaction` — 是否存在未提交的事务（`BEGIN` 后尚未结束）。
- `db.rollback()` — 回滚当前事务，没有事务时返回 `false`。

> `node:sqlite` 不支持通过 `PRAGMA autocommit` 读取事务状态（该 pragma 返回空值），
> 因此本库用「尝试再开一个事务」来探测：在事务内执行 `BEGIN` 会立即报
> `cannot start a transaction within a transaction`，据此判定；探测成功则立刻 `ROLLBACK` 撤掉这个空事务。

#### `db.busyTimeout` / `db.setBusyTimeout(ms)` / `db.isLocked()`

锁等待会发生在同步 API 内部并阻塞事件循环，这三个成员用于控制与规避该阻塞：

| 成员 | 说明 |
| --- | --- |
| `db.busyTimeout` | 当前生效的等待时长（毫秒），可用于估算最坏阻塞时间 |
| `db.setBusyTimeout(ms)` | 运行时调整等待窗口；设为 `0` 即「宁可立即失败也不阻塞」 |
| `db.isLocked()` | 不等待地探测当前是否被其他连接锁定，用于写入前判断 |

```typescript
// 事件循环敏感的场景：先探测，避免盲目进入最长 busyTimeout 的同步等待
if (!db.isLocked()) {
  User.create({ name: '张三' });
} else {
  // 稍后重试，或交给队列异步处理
}

// 或者把等待窗口压到最短
db.setBusyTimeout(0);
```

`isLocked()` 的实现是「`BEGIN IMMEDIATE` 成功则未锁」——它只探测**写锁**，
不反映「是否有读事务」；WAL 下读事务不会阻塞写入，所以这个语义正是调用方需要的。

#### `db.isOpen`

数据库是否处于打开状态。`close()` 之后为 `false`。

#### `db.prepare(sql)` / `db.exec(sql)`

逃生舱：直接使用底层 `node:sqlite` 的 `StatementSync` 与 `exec()`，
用于本库暂未封装的场景（建索引、PRAGMA、`VACUUM`、FTS5 等）。

```typescript
// exec：执行一段 SQL，无返回值（可含多条语句）
db.exec('CREATE INDEX IF NOT EXISTS users_age ON users (age)');

// prepare：返回可复用的预编译语句
const stmt = db.prepare('SELECT COUNT(*) AS n FROM "users" WHERE "age" > ?');
const row = stmt.get(18) as { n: number };
```

- 两条路径都会在遇到只读错误时自动重开连接并重试一次；
- **不会做任何校验**：SQL 原样执行，`?` 之外的拼接由调用方负责。用于业务数据值时请自己绑定参数，
  不要拼接用户输入；
- `db.exec` 的语句里如果出现表名 / 列名，也只能来自代码中的常量。

#### `db.reopenAfterReadOnly()`

手动触发「只读连接恢复」：关闭当前连接、重新打开，并探测一次写能力，成功返回 `true`。

正常情况下不需要调用——`prepare` / `exec` / 模型写入路径都会在识别到 `SQLITE_READONLY` 时自动恢复。
只有在**事务进行中**不会自动恢复（重开连接会丢事务），此时可以直接调用它拿到明确的布尔结果，
或等待事务结束后重试。

### `class Model<F>`

`db.model()` 的返回值，泛型 `F` 为字段定义，自动推导字段名和值类型。

#### 实例属性

| 属性 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | 注册时使用的模型名 |
| `tableName` | `string` | 绑定的数据表名 |
| `db` | `Database` | 模型背后的连接，用于 JOIN / 子查询等本库未覆盖的写法 |
| `fields` | `Readonly<F>` | 声明时的字段表（冻结的副本） |

`db` 和 `fields` 是给「模型层表达不了」的场景准备的逃生口：

```typescript
// JOIN：直接复用同一个连接，事务也在一起
const rows = User.db.prepare(`
  SELECT u."name", COUNT(o."id") AS orders
  FROM "users" u LEFT JOIN "orders" o ON o."userId" = u."id"
  GROUP BY u."id"
`).all();

// 通用后台 / 动态表单：反射字段声明，不必另存一份
for (const [field, type] of Object.entries(User.fields)) {
  console.log(field, type);
}
```

`fields` 返回的是构造时浅拷贝并冻结的对象——改写它既不会影响模型行为，
也不会影响你自己传进去的那份 `fields` 字面量。

**方法可以直接解构**：所有公开方法在构造时绑定到实例上，因此下面两种写法都成立：

```typescript
const { create, count } = User;
create({ name: '张三' });
count();

// 作为回调传递也不会丢 this
const rows = [{ name: '张三' }, { name: '李四' }].map(User.create);
```

绑定产生的是**不可枚举**的自有属性，`Object.keys(User)` / `JSON.stringify(User)` 的外观与绑定前一致。
代价是每个模型实例多 19 个闭包，单个 `Database` 上模型数量有限，可以忽略。

#### `create(data): ModelRow<F>`

插入一条记录，返回包含自动生成 `id` 的完整行。

- 只接受模型已声明的字段；未提供的字段存储为 `NULL`，显式传 `null` 也可以。
- `id` / `createdAt` / `updatedAt` 不能通过参数指定（传了抛 `ValidationError`）。
- `createdAt` / `updatedAt` 自动写入当前时间，两者取值相同。
- 空对象（或全部为 `undefined`）抛 `ValidationError`，不会生成无效 SQL。
- 未知字段、值类型不匹配抛 `ValidationError`。
- 写入后会回读整行再返回（一次额外的 `SELECT`），所以返回值里的值就是数据库中的实际值，
  包括 SQLite 可能做的隐式转换（例如 `INTEGER` 列存 `3.0` 读回 `3`）。

**性能提示**：每次 `create()` 都是独立事务，默认 `synchronous = FULL` 下每次都要 fsync，
单条写入在机械盘 / 网络盘上可能慢到几十毫秒（本机 `journalMode: 'DELETE'` 下实测仅 69 ops/s）。
批量场景请用 [`createMany()`](#createmanyrows-options-number) 或包在 `db.transaction()` 里。

#### `findById(id): ModelRow<F> | undefined`

按自增主键查询单条记录；不存在返回 `undefined`。`id` 必须是正的安全整数（`0`、`1.5`、`'1'` 都会抛 `ValidationError`）。

支持 `{ select }` 投影，返回类型相应收窄。

#### `findMany(where?, options?): ModelRow<F>[]`

条件查询，返回数组（无匹配返回空数组）。

- 不传条件（或传空对象）时查询全部记录；
- 多个字段之间为 AND 关系；
- 默认按 `id` 降序（`ORDER BY "id" DESC`）；
- 不允许传入任意 SQL；条件中的 `null` 会被拒绝（SQL 中 `column = NULL` 永远不成立），判空请用 `{ isNull: true }`。

`where` 的值可以是**标量**（等价于等值判断），也可以是**操作符对象**：

| 操作符 | 说明 | 示例 |
| --- | --- | --- |
| 标量 | 等值 | `{ age: 25 }` |
| `eq` / `ne` | 等于 / 不等于 | `{ age: { ne: 0 } }` |
| `gt` / `gte` / `lt` / `lte` | 比较（同一字段可组合，之间为 AND） | `{ age: { gte: 18, lt: 60 } }` |
| `in` | 集合包含（非空数组，元素不能为 `null`） | `{ status: { in: ['a', 'b'] } }` |
| `between` | 闭区间 `[min, max]`，请保证 `min <= max` | `{ score: { between: [0, 100] } }` |
| `isNull` | `true` → `IS NULL`，`false` → `IS NOT NULL` | `{ email: { isNull: false } }` |

```typescript
// 最近注册、未删除、分数在区间内的成年用户
const users = User.findMany({
  age: { gte: 18, lt: 60 },
  score: { between: [60, 100] },
  email: { isNull: false },
}, { orderBy: 'age', order: 'ASC', limit: 20 });
```

- 操作符是固定白名单，`{ age: { like: 1 } }`、`{ age: { in: [] } }`、`{ age: { in: [null] } }`、
  `{ age: { between: [1] } }`（长度不为 2）、类型不匹配的值都会抛 `ValidationError`（编译期同样能发现）；
- 同一字段的多个比较操作符之间是 AND，可以组合（`{ age: { gte: 18, lt: 60 } }`）；
  互斥的组合（如 `{ age: { eq: 2, gt: 100 } }`）不会报错，只是永远查不到行；
- **`between` 不校验端点顺序**：`{ between: [100, 0] }` 等价于 `x >= 100 AND x <= 0`，恒为空结果。
  端点写反是很容易犯的错，且不会报错，建议在调用前自行保证 `min <= max`；
- 超长的 `in` 列表会自动拆成多段并以 `OR` 连接：每段最多 **500** 个绑定参数
  （`in: [1, 2, …, 1200]` → 3 段 `"col" IN (…) OR "col" IN (…) OR …`）。
  实测 600 项能正确命中 600 行。分段是为了避开 SQLite 单语句 32766 个绑定参数的上限。

**关于字段名大小写**（很容易踩）：

- **模型声明的字段大小写敏感**：声明的是 `name`，就只能在条件里写 `{ name: ... }`；
  `{ NAME: 'x' }` 会被当作未知字段拒绝。
- **托管列大小写不敏感**：`id` / `ID`、`createdAt` / `createdat` / `CreatedAt` 都可用，
  且在拼 SQL 前会被规范化成声明时的写法（`createdAt`），因此不会因为大小写拿到不同的列。
- `select` 同样会规范化托管列的大小写；返回值里的键始终是规范写法。

**关于托管列（`id` / `createdAt` / `updatedAt`）**——它们与模型字段一视同仁地可读：

- `id` 按 INTEGER 校验（必须是正的安全整数，`{ id: 0 }` 会被拒绝而不是静默返回空数组）；
- `createdAt` / `updatedAt` 按 TEXT 校验，例如 `{ createdAt: { gte: '2026-01-01T00:00:00.000Z' } }`
  （ISO 8601 UTC 字符串的字典序与时间序一致）；
- 只有**写入**路径（`create` / `update` 的 data、`upsert` 的 `update`）才拒绝托管列；
- 详细规则见[托管字段](#托管字段id--createdat--updatedat)。

> `where` 传 `{}`（或 `undefined`）表示「无过滤」，`findMany` / `count` / `exists` / `findOne` 都接受；
> 但 `deleteMany({})` / `deleteMany()` 会被拒绝——读全表和删全表代价不对称，见 [`deleteMany`](#deletemanywhere-options-mutationresult)。

`options` 排序与分页选项（全部可选，字段名和类型错误在编译期即可发现）：

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `orderBy` | 模型声明的字段名 \| 托管列名 | 排序字段，默认 `id`；`id` / `createdAt` / `updatedAt` 同样可用 |
| `order` | `'ASC' \| 'DESC'` | 排序方向，默认 `DESC` |
| `limit` | `number` | 返回的最大记录数，必须是正整数 |
| `offset` | `number` | 跳过的记录数，必须是非负整数，且必须与 `limit` 一起使用 |
| `select` | 列名数组 | 只查询指定列（字段投影）；返回类型收窄为这些列 |

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

// 配合 count() 组装分页元信息（带同样的过滤条件）
const total = User.count({ age: { gte: 18 } });
const totalPages = Math.ceil(total / pageSize);
```

非法选项都会抛 `ValidationError`：未知排序字段（含注入尝试）、非法方向（如 `'asc'`、`'RANDOM()'`）、
非正整数 `limit`（含 `0`）、无 `limit` 的 `offset`，以及未知选项键
（如把 `limit` 拼写错——避免被静默忽略后意外加载全表）。`limit` / `offset` 通过参数绑定传入。

`offset` 分页的代价随页码线性增长，数据量大或需要「无限滚动」时请改用 [`findPage()`](#findpageoptions-pagemodelrowf)。

#### `findOne(where?, options?): ModelRow<F> | undefined`

查询单条记录，无匹配返回 `undefined`。等价于 `findMany(where, { ...options, limit: 1 })[0]`，
但内部直接 `SELECT ... LIMIT 1`，不分配中间数组。

```typescript
const user = User.findOne({ email: 'a@example.com' });
const earliest = User.findOne({ status: 'pending' }, { order: 'ASC' });   // 最早的一条
```

- 默认返回 `id` 最大的那一条（与 `findMany` 的默认排序一致）；
- 匹配到多行不报错，只返回排序后的第一行；
- **不接受 `limit` / `offset`**（语义上恒为 1），传了会抛 `ValidationError`；
- 支持 `select` 投影，返回类型相应收窄：

  ```typescript
  const name = User.findOne({ age: 25 }, { select: ['name'] })?.name;   // string | undefined
  ```

#### `exists(where?): boolean`

判断是否存在匹配记录，内部是 `SELECT 1 ... LIMIT 1`。

```typescript
if (User.exists({ email: 'a@example.com' })) throw new Error('already registered');
```

只需要布尔结果时用它，而不是 `count(...) > 0`——后者必须扫描完所有匹配行。
不传条件等价于「表非空」。条件校验与 `findMany` 完全一致。

#### `findByIds(ids): Array<ModelRow<F> | undefined>`

按主键批量查询，一次 `WHERE id IN (...)` 取回全部行，替代 `ids.map(findById)` 的 N 次往返。

```typescript
const rows = User.findByIds([3, 1, 2]);
// rows[0] 对应 id=3，rows[1] 对应 id=1；不存在的 id 对应 undefined
```

- **返回数组长度恒等于 `ids.length`**，`rows[i]` 与 `ids[i]` 一一对应，不必再按 id 建索引；
  不想保留占位符时用 `rows.filter(Boolean)`，或改用 `findMany({ id: { in: ids } })`；
- 重复的 id 会返回重复的行（同样保持位置对应）；
- 空数组返回 `[]`，不执行任何查询；单次最多 10000 个 id，超出抛 `ValidationError`
  （再大请分批调用，避免一次读入过多记录）；
- 内部按 500 一段自动分批，超出 SQLite 绑定参数上限也不会失败；
- 返回的是完整行，暂不支持 `select` 投影。

#### 字段投影（`select`）

`SELECT *` 会把 BLOB、长 TEXT 也读出来并复制进 JS 堆，列表页通常只需要少数字段：

```typescript
const rows = User.findMany({ age: { gte: 18 } }, { select: ['id', 'name'] });
// rows 的类型是 Array<{ id: number; name: string | null }>，age 不在其中
```

- 返回值类型随 `select` 自动收窄（`findById` / `findOne` / `search` / `findPage` 同样支持）；
- 允许托管列 `id` / `createdAt` / `updatedAt`，且大小写会被规范化为声明时的写法；
- 未知列、重复列、空数组、非数组都会抛 `ValidationError`——列名同样是拼接进 SQL 的，走的是同一套白名单；
- 投影只影响读出的列，**不影响**条件与排序（`where` / `orderBy` 里照常可以使用未选出的列）。

#### `findPage(options?): Page<ModelRow<F>>`

游标（keyset）分页。用「排序字段值 + 主键」组成的游标定位下一页，**不使用 `OFFSET`**。

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `orderBy` | 模型声明的字段名 \| 托管列名 | 排序字段，默认 `id`；`id` / `createdAt` / `updatedAt` 同样可用 |
| `order` | `'ASC' \| 'DESC'` | 排序方向，默认 `DESC` |
| `limit` | `number` | 每页条数，默认 `20`，必须是正整数 |
| `after` | `Cursor \| null` | 上一页返回的 `nextCursor`；不传或传 `null` 表示第一页 |
| `select` | 列名数组 | 字段投影；**运行时会自动补入排序字段与 `id`**（否则无法生成游标），见下方说明 |

返回 `{ items, nextCursor, hasMore }`。

```typescript
let cursor = null;
for (;;) {
  const page = User.findPage({ orderBy: 'age', order: 'ASC', limit: 20, after: cursor });
  render(page.items);
  if (!page.hasMore) break;
  cursor = page.nextCursor;
}
```

实现细节：每次多取一行（`LIMIT limit + 1`）来判断 `hasMore`，因此**不需要额外发一次 `COUNT`**；
`nextCursor` 由最后一行的 `(排序字段值, id)` 组成，`orderBy` 为 `id` 时 `value` 为 `null`；
排序字段为 BLOB 时 `value` 是 `Uint8Array`（原样回传即可）。游标值与排序列的类型不一致
（例如把别的查询的游标丢进来）会抛 `ValidationError`——SQLite 跨类型比较不会报错，只会静默返回错页。

> **`select` 与游标的类型陷阱**：`findPage` 必须知道排序字段与主键才能生成 `nextCursor`，
> 因此即使 `select` 里没写，也会把这两列补进 SQL。但**返回类型只反映 `select` 里列出的列**，
> 运行时多出来的属性不在类型里：
>
> ```typescript
> const page = User.findPage({ orderBy: 'age', select: ['name'] });
> // 实际 SQL 选的是 name, age, id
> page.items[0]!.name;   // ✅ 类型可见
> page.items[0]!.id;     // ❌ 编译报错，但运行时确实存在
> page.items[0]!['id'];  // 需要时用 in 收窄，或干脆把 id 写进 select
> ```
>
> 想拿到带类型的 `id`，就显式写进 `select`——多写一列，类型才准确。

为什么不用 `OFFSET`：

- **深分页不退化**。`OFFSET 25000` 要先扫过 2.5 万行再丢弃，游标条件可以直接从索引定位起点。
  5 万行实测（`.workbuddy/stress/bench-page.ts`）：第 1251 页 `OFFSET` **80.5ms**，同位置游标 **7.4ms**，
  且游标耗时与页码无关；
- **翻页期间插入新行不会错位**。`OFFSET` 分页在有新行插入时会把已看过的行再返回一次，游标不会；
- **排序确定**。排序字段有重复值时用主键 `id` 作为次级键，方向与主排序一致，顺序稳定；
- **NULL 行不丢**。SQLite 把 NULL 当最小值，升序在最前、降序在最后；实现里对 NULL 段单独分支，
  不能用行值比较 `(a, b) > (x, y)`（该写法遇到 NULL 恒为 NULL，会静默跳过整段 NULL 行）；
- 不接受 `options.offset`（与游标语义冲突），传了会明确报错。

#### `search(keyword, options?): ModelRow<F>[]`

关键字搜索：对 TEXT 字段做子串匹配（`LIKE '%keyword%'`），任意字段命中即返回（OR 语义）。

- `keyword: string` — 非空字符串；SQLite 的 `LIKE` 对 ASCII 大小写不敏感（`zhang` 可命中 `Zhang`），中文不受影响；
- `%` 与 `_` 作为 LIKE 通配符原样生效：`张_` 会匹配「张三」「张四」，`100%` 会匹配任何以 `100` 开头的值；
- **本库没有声明 `ESCAPE` 子句**，因此 `\%` / `\_` **不会**被转义成字面量——
  `search('100\\%')` 里的 `\` 是普通字符，最终模式等价于「含 `100\` 后接任意内容」，实测返回空数组。
  需要精确匹配含 `%` / `_` 的字面量时，请用 `where` 的等值条件，或自己写带 `ESCAPE` 的 SQL：

  ```typescript
  db.prepare(`SELECT * FROM "users" WHERE "name" LIKE ? ESCAPE '\\'`).all('100\\%');
  ```

- `options.fields` — 参与搜索的 TEXT 字段数组（编译期即限定为 TEXT 字段名），缺省为模型声明的全部 TEXT 字段；
- `options` 其余选项与 `findMany` 完全一致（`orderBy` / `order` / `limit` / `offset` / `select`）；
- 关键字（含 `%` 包裹）整体作为参数绑定值传入，不拼接 SQL；
- 无论声明了多少个 TEXT 字段，最终都拼成**一条**语句（`WHERE ("a" LIKE ? OR "b" LIKE ?)`），
  因此字段多也不会触发绑定参数上限；
- 模型没有 TEXT 字段、或传入非法字段（未知字段、非 TEXT 类型、重复、空数组）时抛 `ValidationError`；
- 搜索没有索引可用（`LIKE '%x%'` 前导通配符无法走 B-Tree 索引），数据量大时是**全表扫描**。
  需要高性能前缀匹配时，请用裸 SQL 配合 `LIKE 'x%'`，或引入 SQLite 的 FTS5 扩展。

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

返回记录数量，支持与 `findMany` 完全一致的条件（等值与全部操作符）。

`options`：

| 选项 | 类型 | 说明 |
| --- | --- | --- |
| `keyword` | `string` | 对 `fields` 的 TEXT 字段做 OR LIKE 匹配（语义同 `search`），与 `where` 条件为 AND 关系 |
| `fields` | TEXT 字段名数组 | 参与关键字搜索的字段，缺省为全部 TEXT 字段；必须与 `keyword` 一起使用 |
| `column` | 列名 | 改用 `COUNT(col)` 统计该列**非 NULL** 的行数；省略时是 `COUNT(*)` |

```typescript
// 有邮箱 / 没邮箱各多少（两者相加等于总行数）
const filled = User.count(undefined, { column: 'email' });
const missing = User.count() - filled;
```

- `column` 同样接受托管列（`count(undefined, { column: 'id' })` 等于 `count()`，
  因为主键恒非 NULL；统计 `createdAt` 可用来发现「旧表迁移过来的行」）；
- `keyword` 与 `fields` 必须成对出现：只传 `keyword` 会用全部 TEXT 字段，
  只传 `fields` 会被拒绝（没有关键字就没有匹配条件）；
- 与 `search()` 一样走全表扫描（含 `LIKE '%x%'`），大数据集上统计耗时不可忽略。

#### `update(id, data): ModelRow<F> | undefined`

按 `id` 更新记录，只更新传入的字段，返回**更新后的整行**；记录不存在返回 `undefined`。

```typescript
const updated = User.update(id, { age: 31 });
if (updated === undefined) notFound();
```

- `updatedAt` 自动刷新为当前时间；
- 写入与回读在同一个事务中完成，不会读到并发写入的中间状态
  （代价是比纯 `UPDATE` 多一次 `SELECT`，且会开启一个 `BEGIN IMMEDIATE` 写事务）；
- **在已有事务内调用时会加入外层事务**，不再另开一个；
- 拒绝空更新对象（`{}` 或全部为 `undefined`）；
- 不允许修改主键 `id` / `createdAt` / `updatedAt`；
- 字段和值分别校验（未知字段 / 类型不匹配抛 `ValidationError`）；
- 更新不存在的 `id` 不会报错，返回 `undefined`（幂等的「更新或忽略」语义）。

> 旧版本返回 `boolean`。`if (User.update(...))` 这类写法对行对象依然成立，但
> `User.update(...) === true` 需要改为 `!== undefined`。

如果需要「更新或插入」的语义，用 [`upsert()`](#upsertdata-options-modelrowf) 而不是
`update() ?? create()`——后者在并发下会撞主键。

#### `delete(id): ModelRow<F> | undefined`

按 `id` 删除一条记录，返回**被删除的那一行**（删除前的快照）；记录不存在返回 `undefined`。

```typescript
const removed = User.delete(id);
if (removed !== undefined) audit.log('deleted', removed);
```

先读后删，两步在同一事务中完成，因此返回的快照一定就是被删掉的那一行。
需要「是否删掉了」的布尔值，判断返回值是否为 `undefined` 即可。

> 若该行正被外键引用（且子表未声明 `ON DELETE CASCADE`），删除会抛
> `ForeignKeyConstraintError`，返回值为空且数据保持不变。

#### `createMany(rows, options?): number[]`

批量插入，返回按参数顺序排列的自增 id。

```typescript
const ids = User.createMany([
  { name: '张三', age: 25 },
  { name: '李四', age: 30 },
]);
```

- 整批在**一个事务**中完成（已在事务中则加入外层事务）；
- 所有行必须声明**相同字段**（省略等价于 `undefined`，显式 `null` 与省略都写入 NULL）；
  字段集合不一致时抛 `ValidationError`，除非显式传 `{ strictFields: false }`；
- 不逐行回读整行，这是它比循环 `create()` 快的主要原因；需要完整行时用返回的 id 自行查询；
- 整批共用一个 `createdAt` / `updatedAt` 时间戳——即使因 `chunkSize` 拆成多条语句，时间戳仍在循环外生成一次
  （实测 1200 行跨 3 条语句，时间戳只有 1 种取值）；
- 任一行失败（类型错误、约束冲突）则整批回滚；
- `options.chunkSize`（默认 500，范围 1–5000）控制单条语句携带的行数；
- 空数组返回空数组。

**分批的准确算法**：实际每条语句的行数是

```
min(chunkSize, floor(30000 / (字段数 + 2)))
```

额外按绑定参数总量再收敛一次（每行占「字段数 + 2 个时间戳」个参数），
所以**字段很多时单条语句的行数会明显小于 `chunkSize`**，这是正常的保护行为，不是 bug。
例：15 个字段 + `chunkSize: 500` → `floor(30000 / 17) = 1764`，仍取 500；40 个字段 → 取 714 → 仍 500；
80 个字段 → `floor(30000/82) = 365`，此时单条语句只插 365 行。

返回的 id 按参数顺序排列，来自插入语句的 `RETURNING`，只包含**真正插入**的行：
如果表上有 `RAISE(IGNORE)` 这类会静默跳过某些行的触发器，被跳过的行不会出现在返回值里
（数组长度会小于入参长度），此时以返回值而非下标对应入参。

**吞吐参考**（本机 SSD，`synchronous = FULL`，字段数 4）：

| 方式 | WAL | DELETE |
| --- | --- | --- |
| `create()` × 2000（逐条） | ≈ 850 ops/s | ≈ 70 ops/s |
| `db.transaction()` 包裹 2000 次 `create()` | ≈ 2.6 万 ops/s | ≈ 2.3 万 ops/s |
| `createMany(2000)` | ≈ 25–28 万 ops/s | ≈ 8 万 ops/s |
| `createMany(20000)` | ≈ 25 万 ops/s | ≈ 21 万 ops/s |

绝对数字随硬件波动，但量级关系很稳定：**批量写入比逐条快 300 倍以上**，
而 `journalMode: 'DELETE'` 下的逐条写入是最差的组合（每次都要 fsync 回滚日志）。

#### `upsert(data, options?): ModelRow<F>`

插入一行；若与 `options.on` 指定的唯一约束冲突，则更新该行，返回最终的整行。

```typescript
// 先建唯一索引：CREATE UNIQUE INDEX users_email ON users (email)
User.upsert({ email: 'z@example.com', name: '张三' }, { on: ['email'] });

// 冲突时只更新 name，其余列保持原值
User.upsert({ email: 'z@example.com', name: '李四' }, { on: ['email'], update: { name: '李四' } });
```

- `options.on` 省略时使用主键 `id`（显式写 `on: ['id']` 等价）；指定的列上**必须有唯一约束**，
  否则 SQLite 会直接报错（`SqlModelError`，`cause` 里是
  `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`）；
- `options.update` 省略时用本次传入的数据覆盖冲突行（`createdAt` 与主键除外）；
  显式传 `{}` 表示冲突时不做任何修改（`DO NOTHING`）；
- 冲突且确实执行了 `DO UPDATE` 时会刷新 `updatedAt`——**即使新旧值完全相同**。
  只有 `update: {}`（`DO NOTHING`）才保持原 `updatedAt` 不变；
- 按主键 upsert 需要在 `data` 里带上 `id`。`ModelData<F>` 的类型里没有 `id`，
  因此这条路径需要绕过类型检查（`upsert({ id, ... } as never)`）；
  更常见的用法是给业务唯一列建唯一索引后传 `on: ['email']`；
- 省略 `on` 且 `data` 里没有 `id` 时，每行都会走 INSERT；若撞上其他唯一索引，
  会抛 `UniqueConstraintError` 而不是静默更新。

#### `upsertMany(rows, options?): number`

批量插入或更新，返回语句影响的行数（插入与更新都计 1）。
冲突判定与更新规则同 `upsert()`，整批在一个事务内完成，各行字段集合可以不同，不逐行回读。

#### `updateMany(where, data, options?): MutationResult`

按条件批量更新，返回 `{ changes, statements }`。

```typescript
const { changes } = User.updateMany({ age: { lt: 18 } }, { email: null });
```

- 条件与 `findMany` 完全一致（等值与操作符，不含关键字搜索）；条件不能为空对象；
- `data` 中省略的字段保持不变，`updatedAt` 对这一批行统一刷新为同一时刻（实测整批相同）；
- 内部**先查主键再分批**：先 `SELECT id ... WHERE …` 拿到目标行，再按
  `options.chunkSize`（默认 500）分批执行 `UPDATE ... WHERE id IN (...)`。
  多一次全表扫描的代价换来的是「单条语句只锁少量行」，大表批量更新时更友好
  （但要注意：命中的 id 会一次性读进内存）；
- 整批在一个事务中，任一步失败全部回滚；空更新对象抛 `ValidationError`；
- `statements` 是实际执行的 `UPDATE` 条数，可用于观察分批是否按预期工作。

#### `deleteMany(where, options?): MutationResult`

按条件批量删除，返回 `{ changes, statements }`，分批与事务语义同 `updateMany`。

```typescript
User.deleteMany({ age: { lt: 18 } });
```

- **必须提供非空条件**：`deleteMany()` 与 `deleteMany({})` 都会抛 `ValidationError`。
  读取（`findMany()` 返回全表）与删除（清空全表）的代价并不对称，
  一次误调用就是不可恢复的数据丢失，因此清空必须显式声明意图；
- 「非空」看的是**解析后的条件**：`{ age: undefined }` 虽然有键，但该字段不参与筛选，
  等价于无条件，同样会被拒绝；
- 确实要清空时用 `clear()`，或显式传 `{ confirm: 'all' }` 走同一个入口；
- `options.confirm` 只接受字面量 `'all'`，传其他值（如 `'yes'`）也会抛 `ValidationError`。

```typescript
User.deleteMany();                       // ❌ ValidationError
User.deleteMany({});                     // ❌ ValidationError
User.deleteMany({ age: { lt: 18 } });    // ✅
User.deleteMany({}, { confirm: 'all' }); // ✅ 清空整表（等价于 clear()）
```

注意「非空条件」不等于「安全条件」：`{ age: { gte: 0 } }` 是合法条件，但会删掉几乎所有行。
护栏只能拦住**忘记传条件**，拦不住写错条件。

#### `clear(options?): MutationResult`

清空整张表（`DELETE FROM`，不重置自增序列），返回 `{ changes, statements }`。

```typescript
User.clear();                    // 删掉全部行
User.clear({ chunkSize: 1000 }); // 大表分批删除，缩短单次写锁持有时间
```

单独成方法是为了让「删全部」在调用处一眼可见，不必依赖阅读条件参数。

> `clear()` 内部同样是「先查主键 → 分批 DELETE」，因此**一千万行的表会先把一千万个 id 读进内存**。
> 超大表清空建议直接用裸 SQL：`db.exec('DELETE FROM "users"')`，它是一条语句、不占额外内存。
> 自增序列不会重置（下一个 id 继续往后走）；需要重置请
> `DELETE FROM sqlite_sequence WHERE name = 'users'`，但已删除 id 不应被复用，通常不建议这么做。

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

> `ADD COLUMN` 只能加可空列、不能加 `NOT NULL`（无默认值时）、也不能改类型。
> 需要更复杂的结构变更时，请走「新建表 → 复制数据 → 改名」的经典迁移流程。

#### `deleteField(field): boolean`

删除数据表中一个**模型未声明**的字段（`ALTER TABLE ... DROP COLUMN`）。需要用户显式调用。

- 为避免误删，主键 `id` 和模型声明的字段都会被拒绝（抛 `ValidationError`，大小写不敏感）；
- 字段不存在时返回 `false`，删除成功返回 `true`；
- 字段名同样只接受合法标识符；
- **该列上若有索引，删除会失败**。本库的错误信息是脱敏的通用文本
  （`Executing a statement failed: SQLite error 1`），SQLite 的原始原因
  `error in index <name> after drop column` 挂在 `error.cause` 上。
  先 `DROP INDEX` 再删列，见[索引章节](#没有索引声明能力时怎么建索引)。

典型工作流：从模型定义中移除字段 → 表中该列成为多余列 → 确认不再需要后手动删除：

```typescript
// 模型中已移除 age 字段，但表里的 age 列仍在
User.deleteField('age'); // => true
User.deleteField('age'); // => false（列已不存在）

User.deleteField('name'); // 抛 ValidationError：name 是模型声明的字段
User.deleteField('id');   // 抛 ValidationError：id 是主键
User.deleteField('createdAt'); // 抛 ValidationError：自动管理的时间戳字段
```

> `DROP COLUMN` 需要 SQLite ≥ 3.35.0；Node.js 22.5+ 内置的 SQLite（实测 3.51.2）均满足。

#### 托管字段（`id` / `createdAt` / `updatedAt`）

每张表自动带有三列，规则完全一致：**任何读位置可用，任何写位置不可用**。

| 字段 | 类型 | 行为 |
| --- | --- | --- |
| `id` | INTEGER | 自增主键，从 1 开始；由 SQLite 分配 |
| `createdAt` | TEXT | `create()` 时写入当前时间（ISO 8601 UTC，毫秒精度），之后永不变化 |
| `updatedAt` | TEXT | `create()` 时写入当前时间，每次 `update()` / `updateMany()` / `upsert()` 的 `DO UPDATE` 刷新 |

**可读位置**（大小写不敏感，会自动规范化）：

- `where` 条件：`{ id: 3 }`、`{ id: { in: [1, 2] } }`、`{ createdAt: { gte: '2026-01-01T00:00:00.000Z' } }`；
- `orderBy`：`'id'`、`'createdAt'`、`'updatedAt'`；
- `select`：`['id', 'name']`；
- `count(undefined, { column: 'createdAt' })`。

**被拒绝的位置**：

- 模型 `fields` 中声明（抛 `InvalidModelError`，`Id` / `CREATEDAT` 同样被拒）；
- `create()` / `update()` 的 data、`upsert()` 的 `update`（抛 `ValidationError`）；
- `deleteField()`（抛 `ValidationError`）。

```typescript
const user = User.create({ name: '张三', age: 25 });
// user.createdAt === user.updatedAt（同一创建时刻）

User.update(user.id, { age: 26 });
const updated = User.findById(user.id);
// updated.createdAt 不变；updated.updatedAt 已刷新为修改时刻
```

**旧表迁移**：对于旧版本库（或外部工具）创建的、没有时间戳列的表，注册模型时会自动补齐这两列
（`syncFields()` 同样会补齐），已有行的值保持 `NULL`；该行下次 `update()` 时 `updatedAt` 会被写入，
而 `createdAt` 保持 `NULL`（原始创建时间已不可知）。

**精度陷阱**：时间戳是毫秒。同一毫秒内对同一行连续调用两次 `update()`，`updatedAt` 取值完全相同。
需要严格的先后顺序（例如乐观锁）时，请用自增的版本号字段而不是时间戳：

```typescript
// 假设模型里额外声明了 version: 'INTEGER'
// 乐观锁：用版本号而不是 updatedAt 判断「是否被别人改过」
const { changes } = db
  .prepare('UPDATE "users" SET "version" = "version" + 1 WHERE "id" = ? AND "version" = ?')
  .run(id, expectedVersion);
if (changes === 0) throw new Error('concurrent modification');
```

## 类型

| 导出类型 | 说明 |
| --- | --- |
| `FieldType` | `'TEXT' \| 'INTEGER' \| 'REAL' \| 'BLOB'`，字段类型白名单 |
| `FieldValue<T>` | 字段类型 → TS 值类型映射 |
| `ModelFields` | `Record<string, FieldType>`，字段定义 |
| `ModelDefinition<F>` | `{ tableName: string; fields: F }` |
| `ModelRow<F>` | 查询结果 / `create` 返回的行类型：自动字段（`id`、`createdAt`、`updatedAt`）+ 各模型字段（未赋值为 `null`） |
| `ModelData<F>` | 写入数据类型：字段全部可选，允许 `null`，不含托管列 |
| `WhereInput<F>` | 查询条件类型：模型字段（含托管列 `id` / `createdAt` / `updatedAt`）→ 标量或 `FieldCondition`（操作符对象） |
| `FieldCondition<T>` | 单个字段的条件：标量 / `null` / 操作符对象（`eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`in`、`between`、`isNull`） |
| `WhereOperator` | 操作符名称联合类型 |
| `QueryOptions<F>` | `findMany` 的排序与分页选项：`orderBy` / `order` / `limit` / `offset` / `select` |
| `SortableName<F>` | 可排序的列名：模型字段 + 托管列（与 `SelectableName` 同义） |
| `SelectableName<F>` | 可投影的列名：模型字段 + 托管列 |
| `SelectedRow<F, K>` | 投影后的行类型：只保留 `K` 中的列 |
| `ProjectedRow<F, K>` | 投影结果：`K` 为 `undefined` 时是完整 `ModelRow<F>` |
| `SearchOptions<F>` | `search` 的选项：`fields`（参与搜索的 TEXT 字段）+ `QueryOptions` |
| `CountOptions<F>` | `count` 的选项：`keyword` / `fields` / `column`（按列统计非 NULL 行） |
| `Cursor` | 游标：`{ value, id }`，由上一页的 `nextCursor` 给出，原样回传即可 |
| `PageOptions<F>` | `findPage` 的选项：`orderBy` / `order` / `limit` / `after` |
| `Page<R>` | `findPage` 的返回值：`items` / `nextCursor` / `hasMore` |
| `CreateManyOptions` | `createMany` 的选项：`chunkSize` / `strictFields` |
| `UpsertOptions<F>` | `upsert` / `upsertMany` 的选项：`on` / `update` |
| `UpdateManyOptions` | `updateMany` 的选项：`chunkSize` |
| `DeleteManyOptions` | `deleteMany` 的选项：`chunkSize` / `confirm`（`'all'` 才允许无条件删除） |
| `MutationResult` | 批量更新 / 删除的结果：`changes` / `statements` |
| `ModelDataTuple<F>` | 批量写入的行数组类型（每行独立应用 `ModelData<F>`） |
| `TextFieldNames<F>` | 模型中 TEXT 字段的字段名联合类型 |

字段类型与 TypeScript 值类型的对应关系：

| SQLite 类型 | 写入接受 | 读出得到 |
| --- | --- | --- |
| `TEXT` | `string` | `string \| null` |
| `INTEGER` | `number`（安全整数） | `number \| null` |
| `REAL` | `number`（有限数值） | `number \| null` |
| `BLOB` | `Uint8Array` | `Uint8Array \| null` |

以下错误在编译期即可被 TypeScript 发现：

```typescript
User.create({ name: 123 });           // 错误：TEXT 字段需要 string
User.create({ unknownField: 'x' });   // 错误：未知字段
User.create({ id: 1 });               // 错误：id 由数据库分配
User.update(1, { age: '二十五岁' });   // 错误：INTEGER 字段需要 number
User.update(1, { id: 2 });            // 错误：不允许修改主键
User.findMany({ age: '25' });         // 错误：查询条件类型不匹配
User.findMany({ id: '1' });           // 错误：id 条件只接受 number
User.findOne({}, { limit: 2 });       // 错误：findOne 不接受 limit
User.deleteMany();                    // 错误：参数必须提供
```

## 值类型与 NULL 语义

SQLite 是动态类型 + 三值逻辑，这里列出本库的具体取舍，避免在边界上写出「看起来对但查不到」的代码。

**`undefined` 与 `null`**

- 写入时两者等价，都存为 `NULL`（`create({ email: undefined })` 与 `create({ email: null })` 结果相同）；
- 但**条件里** `undefined` 表示「这个字段不参与筛选」，会被跳过：`{ age: undefined }` 等价于 `{}`；
- 条件里的 `null` 会被拒绝，因为 `column = NULL` 永远不成立。判空必须用 `{ isNull: true }`。

**三值逻辑与 `ne`**

`{ email: { ne: 'a@x' } }` 翻译成 `"email" <> ?`。对 `email IS NULL` 的行，该表达式的结果是 `NULL`（不是 true），
因此**这些行不会被返回**。这通常不符合直觉。需要「不等于 a@x，或为空」时，本库不支持 OR，
请分两次查询再合并：

```typescript
const others = User.findMany({ email: { ne: 'a@x' } });
const blanks = User.findMany({ email: { isNull: true } });
```

同理，`count({ email: { ne: 'a@x' } })` 不包含 NULL 行，与 `count() - count({ email: 'a@x' })` 不相等。

**BLOB**

传入和读出的都是 `Uint8Array`，往返无损（`[1,2,3]` 存入再读出仍是 `[1,2,3]`）。
BLOB 会被完整复制进 JS 堆，大字段建议用 `select` 排除在列表查询之外。

**大整数**

`node:sqlite` 对超出 `Number.MAX_SAFE_INTEGER` 的整数返回 `bigint`。本库统一收敛为 `number`，
转换后若仍超出安全范围则抛 `SqlModelError`，而不是静默丢精度。因此 `id`、`changes`、`COUNT(*)` 一定是 `number`。

## 错误类型

所有错误继承自 `SqlModelError`，均包含明确的英文错误信息（不含表名 / 字段名 / 业务数据等敏感信息）：

| 错误类 | 触发场景 |
| --- | --- |
| `SqlModelError` | 基类；SQLite 返回超出安全整数范围的数值等内部异常，底层原始错误挂在 `cause` 上 |
| `DatabaseClosedError` | 数据库关闭后继续操作 |
| `InvalidModelError` | 模型定义非法：表名 / 字段名 / 字段类型不合法，模型名或表名重复 |
| `ValidationError` | CRUD 参数非法：未知字段、值类型不匹配、空数据、非法 id、未知操作符、查询条件传 null 等 |
| `TransactionError` | 事务使用不当：嵌套调用 `db.transaction()`、在事务中关闭数据库 |
| `LockTimeoutError` | 数据库被其他连接锁定，且在 `busyTimeout` 内未能取得锁（`errcode` 保留 SQLITE_BUSY / SQLITE_LOCKED） |
| `ConstraintError` | 约束冲突基类，所有具体约束错误都继承它，并带有 SQLite 的 `errcode` |
| `UniqueConstraintError` | 违反唯一约束：主键或唯一索引上已有相同值（`errcode` 1555 / 2067） |
| `NotNullConstraintError` | 必填列为空（`errcode` 1299） |
| `ForeignKeyConstraintError` | 外键冲突：引用了不存在的父行，或父行仍被子行引用（`errcode` 787） |
| `CheckConstraintError` | 列值不满足 CHECK 约束（`errcode` 275） |

底层 SQLite 错误不会原样冒泡：锁冲突统一抛 `LockTimeoutError`，约束冲突按类型细分，
其余包装为 `SqlModelError` 并保留 `cause`。因此可以这样区分并重试：

```typescript
import { LockTimeoutError, UniqueConstraintError, isLockConflict } from 'ormlet';

try {
  User.create({ name: '张三' });
} catch (error) {
  if (error instanceof UniqueConstraintError) {
    // 已存在：改为更新，或提示用户
  } else if (error instanceof LockTimeoutError) {
    // 锁竞争：稍后重试，或调大 busyTimeout
  } else if (isLockConflict(error)) {
    // 也能识别被其他层包装过的锁错误
  }
  throw error;
}
```

需要看 SQLite 原始原因时读 `error.cause`：

```typescript
try {
  User.deleteField('extra');   // 该列上有索引
} catch (error) {
  console.error((error as Error).message);                    // 脱敏后的通用信息
  console.error((error as { cause?: Error }).cause?.message); // error in index ... after drop column
}
```

## 常见错误速查

| 报错信息（片段） | 原因 | 处理 |
| --- | --- | --- |
| `Field "id" is managed automatically ...` | 在写路径传了托管列（`id` / `createdAt` / `updatedAt`） | 从 data 中移除；由数据库写入 |
| `The model has no such field in ...` | 字段名拼错或大小写不符（模型字段大小写敏感） | 对照 `fields` 声明 |
| `already registered with a different definition` | 同名 `db.model()` 两次，但表名或字段集合不一致 | 统一两处的模型定义，或复用同一实例 |
| `This tableName is already used by another model` | 两个模型指向同一张表 | 一个表只注册一个模型 |
| `Invalid field name: identifiers must match ...` | 表名 / 字段名含非法字符（空格、中文、`-`） | 改用字母数字下划线 |
| `... options.limit must be a positive integer` | `limit: 0` 或负数 | 至少为 1 |
| `... options.offset requires options.limit` | 只传了 `offset` | 同时传 `limit` |
| `findPage() does not accept options.offset` | 混淆了两种分页 | 改用 `after` 游标 |
| `deleteMany() requires a non-empty where condition` | 忘记传条件 | 用 `clear()` 清空，或补条件 |
| `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint` | `upsert({ on })` 的列上没有唯一索引 | `CREATE UNIQUE INDEX ...` |
| `a row with the same primary key or unique value already exists` | 唯一冲突 | 改用 `upsert()`，或捕获 `UniqueConstraintError` |
| `a required column was left empty` | 外部表上建了 `NOT NULL` 列而写入未提供 | 补值，或在模型外单独处理该表 |
| `a foreign key constraint is violated ...` | 引用了不存在的父行；或删除父行时仍有子行引用 | 先插入父行；删除时先清理子行或用 `ON DELETE CASCADE` |
| `database is locked` / `LockTimeoutError` | 另一个连接持有写锁超过 `busyTimeout` | 单进程单实例；缩短事务；必要时调大 `busyTimeout` |
| `transaction() cannot be nested` | 在事务内又调用 `db.transaction()` | 复用外层事务（模型方法会自动加入） |
| `The database was closed` | 用了已 `close()` 的实例 | 检查生命周期，模型不可跨重启复用 |
| `Executing a statement failed: SQLite error 1` | 常见于 `deleteField` 撞索引、SQL 语法错误 | 看 `error.cause.message` |

## 安全设计

1. **标识符白名单**：表名、字段名、模型名必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`，
   校验通过后才拼接 SQL，并统一使用双引号包裹。
2. **字段白名单贯穿所有路径**：新增、更新、查询条件、排序、投影、计数的字段都来自模型声明；
   `id`、`createdAt`、`updatedAt` 为保留的自动管理字段，不可声明、不可写入、不可删除。
3. **参数绑定**：所有业务数据值一律通过 `DatabaseSync.prepare()` 预编译语句的参数绑定传入，
   不存在用户输入拼接进 SQL 值位置的路径。
4. **双重类型防护**：JS 侧校验值类型（INTEGER 限定安全整数、REAL 限定有限数值），
   建表使用 SQLite `STRICT` 模式在存储层再次强制。
5. **不开启危险扩展**：不启用 `allowExtension`（SQLite 扩展加载）、`enableDoubleQuotedStringLiterals`
   等可能降低安全性的选项。
6. **无敏感信息泄露**：错误信息只描述「哪个环节出错 + 期望什么类型」，
   **不回显表名、字段名、模型名等 schema 信息**，也不回显非法输入原文（避免把注入载荷写进日志）；
   底层 SQLite 的错误消息不会原样透传（其文本内含 SQL 语句），需要时经由 `cause` 显式读取。
   `close()` 关闭连接时若存在未提交事务会回滚并告警，不会静默丢弃写入。

> 逃生舱（`db.exec` / `db.prepare`）**不参与**以上保护：SQL 原样执行。
> 用它拼接业务数据就等于放弃了参数绑定，风险由调用方承担。

## 并发与事务实践

SQLite 的并发模型是「单写多读」：WAL 模式下读互不阻塞、写与写互斥。
本库所有 API 都是**同步**的，理解这一点对避免线上事故很关键。

### 同一进程内的多个 `Database` 实例

```typescript
const a = new Database('./data.db');
const b = new Database('./data.db');   // 同一文件的第二个连接
```

- 两个实例读到的数据是一致的（实测：a 写入后 b 立即可见）；
- **但写与写互斥**：a 持有写事务时，b 的写入会一直等到 `busyTimeout` 用尽，然后抛 `LockTimeoutError`（实测）；
- **推荐做法是一个进程一个 `Database` 实例**，多个模型共享它。
  多实例只有在「同一进程不同模块各自打开了连接」这种误用时才会出现，应该改掉而不是调大 `busyTimeout`。

### 多进程

多个进程各持一个连接访问同一文件是受支持的（`busy_timeout` + WAL 就是为此准备），
但吞吐会随进程数下降，且写事务之间完全串行。压测中 8 进程并发写入未出现锁错误，
但这是「少量进程、短事务」的场景；不要把它当成高并发数据库使用。

### 事务

- `db.transaction()` 用 `BEGIN IMMEDIATE`，**立即**拿写锁。好处是不会在「先读后写」时升级锁失败
  （那种失败会让整个事务前功尽弃）；代价是只读事务也会占写锁，因此**不要用 `transaction()` 包裹纯查询**；
- **不支持嵌套**（同实例内嵌套抛 `TransactionError`）。模型层的 `createMany` / `updateMany` /
  `deleteMany` / `clear` / `update` / `delete` 内部会自动加入外层事务，
  所以在 `db.transaction()` 里直接调用它们是正确的，不会冲突；
- `fn` 必须是**同步函数**。传 `async` 函数会返回一个 Promise 并**立即提交**，
  异步逻辑里的后续写入将落在事务之外——这是最容易踩的坑：

  ```typescript
  // ❌ 错误：await 之后的写入不在事务里
  await db.transaction(async () => {
    User.create({ name: 'a' });
    await sendEmail();            // 事务已经提交了
    User.create({ name: 'b' });   // 这条不在事务里
  });

  // ✅ 正确：事务内只放同步写操作，副作用放到外面
  const id = db.transaction(() => User.create({ name: 'a' }).id);
  await sendEmail();
  ```

- 事务尽量短。`BEGIN IMMEDIATE` 期间其他进程的写入全部阻塞；长事务还会让 `-wal` 持续增长。

### 事件循环阻塞

同步 API 意味着「查询耗时 = 进程卡住的时间」。可以从两方面控制：

1. **缩短单次阻塞**：给查询字段建索引、避免无 `LIMIT` 的全表加载、用 `select` 排除大字段；
2. **避免等待锁**：`db.isLocked()` 先探测，或 `db.setBusyTimeout(0)` 让冲突立刻失败并由上层重试。

在同步 HTTP 服务器里，一个 200ms 的全表扫描会直接拖慢该时刻的所有请求。
重分析类查询请放到 `worker_threads` 里执行。

## 性能与实践

**写**

- 逐条 `create()` 是最慢的方式（每次一个事务 + 一次 fsync + 一次回读 `SELECT`）。
  批量场景一律用 `createMany()`；需要拿到每行完整数据时，用 `createMany()` 返回的 id 再 `findByIds()` 补读；
- `journalMode: 'DELETE'` 下逐条写入仅 ~70 ops/s，WAL 下 ~850 ops/s，差一个数量级；
- 需要多条语句原子执行时用 `db.transaction()`，实测比逐条快 30 倍以上。

**读**

- 除主键外的列**默认没有索引**，`findMany({ email: '…' })`、`findPage({ orderBy: 'age' })` 都是全表扫描。
  数据量上万后必须自己建索引（见[索引章节](#没有索引声明能力时怎么建索引)）；
- 列表查询用 `select` 排除 BLOB / 长 TEXT，减少内存复制；
- `count()` 与 `exists()` 分工：只要布尔值就用 `exists()`，它找到第一行即停；
- 深分页用 `findPage()`，不要用越来越大的 `offset`。

**连接**

- 一个进程一个 `Database`；`close()` 后所有模型立即失效；
- WAL 的 `-wal` 文件会持续增长到 checkpoint。长期只读、不关闭连接时，
  可定期 `db.exec('PRAGMA wal_checkpoint(TRUNCATE)')`。

## 迁移与版本管理

本库不提供迁移框架，但把「加字段 / 删字段 / 建索引 / 记版本」四件事的推荐做法固定下来即可覆盖大部分场景。

**1. 加字段**：只改模型定义，**不要写 `ALTER TABLE`**。重新打开数据库时 `db.model()` 内部的
`syncFields()` 已经会自动 `ADD COLUMN`，旧行该列为 `NULL`。
如果在迁移脚本里再写一遍，会因为列已存在而报 `SqlModelError`
（`cause` 为 `duplicate column name: <name>`）。
另外新增列不要指望 `NOT NULL`——SQLite 的 `ADD COLUMN` 在无默认值时不接受它。

**2. 删字段**：先从模型定义中移除（此后该列不再被读写），再显式 `User.deleteField('old')`。
若该列上有索引，先 `DROP INDEX`。

**3. 建索引**：维护一份幂等清单，启动时执行（见下方[索引章节](#没有索引声明能力时怎么建索引)）。

**4. 记版本号**：用 SQLite 内置的 `PRAGMA user_version`（本库不占用它，值默认为 0）。

```typescript
const CURRENT_VERSION = 3;

const db = new Database('./data.db');
// 注册模型时，模型里已声明但旧库缺失的列会自动补上（syncFields），无需手写 ALTER
const User = db.model('User', {
  tableName: 'users',
  fields: { name: 'TEXT', age: 'INTEGER', nickname: 'TEXT' },
});

const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

// 迁移脚本只做 syncFields 管不到的事：索引、数据回填、重建表
if (version < 1) {
  db.exec('CREATE INDEX IF NOT EXISTS users_age ON users (age)');
}
if (version < 3) {
  db.exec(`UPDATE "users" SET "nickname" = "name" WHERE "nickname" IS NULL`);
}
db.exec(`PRAGMA user_version = ${CURRENT_VERSION}`);
```

`PRAGMA user_version = ?` 不支持参数绑定，上面用的是常量插值——**不要拼接外部输入**。
每个步骤都应该写成本身幂等的（`IF NOT EXISTS` / `WHERE` 限定），
因为版本号写入失败时下次启动会重跑整段。

**备份**：`VACUUM INTO` 可在连接打开时生成一致快照（实测可用）：

```typescript
db.exec(`VACUUM INTO './backup-2026-10-19.db'`);
```

路径同样无法参数绑定，必须来自代码常量。

**更复杂的变更**（改类型、改约束）走标准流程：新建目标结构的表 → `INSERT INTO new SELECT ...` →
`DROP TABLE old` → `ALTER TABLE new RENAME TO old`，整个过程包在 `db.transaction()` 里。

## 资源与错误处理

- `db.close()` 关闭连接，可安全重复调用；关闭后操作抛 `DatabaseClosedError`，不会静默失败。
- CRUD 不会反复创建 / 关闭连接，全部复用 `Database` 持有的唯一连接。
- SQLite 异常（如磁盘错误、约束冲突）正常向上抛出，不会静默吞掉。
- 对 `node:sqlite` 返回的 `number | bigint` 做了统一收敛：超长整数在读取时明确报错，
  `id`、`changes`、`COUNT(*)` 一律以安全整数 `number` 返回。
- 只读连接（`SQLITE_READONLY`）会被自动识别并重开恢复，不需要调用方重试；
  事务进行中除外，此时可用 `db.reopenAfterReadOnly()` 手动恢复。

## 从 1.x 升级

2.0 的不兼容改动只有两处，都在写入返回值上：

| 方法 | 1.x | 2.0 |
|---|---|---|
| `update(id, data)` | `boolean` | 更新后的整行；未命中为 `undefined` |
| `delete(id)` | `boolean` | 被删除行的快照；未命中为 `undefined` |

**布尔上下文里的代码不用改**：命中返回对象（真值），未命中返回 `undefined`（假值），
`if (!User.update(id, data)) { /* 未命中 */ }` 在 1.x 和 2.0 下行为一致。
需要改的是显式写成布尔的地方：

```typescript
// 1.x / 2.0 都能编译，但 2.0 下这段是类型错误
const ok: boolean = User.update(id, { age: 26 });
// 改成：
const ok = User.update(id, { age: 26 }) !== undefined;
```

要多取整行时反而省一次查询——写和读回在同一个事务里完成，不会读到别人并发的修改。

其余都是新增，不影响既有代码：

- 读写两侧都能用托管列：`where: { id: 5 }`、`orderBy: 'createdAt'`（写入位置仍拒绝）；
- 单行读取 `findOne()` / `exists()` / `findByIds()`；
- `deleteMany()` 必须有非空条件，清空整表改用 `clear()`（避免漏传参数误删）；
- 事务 `db.transaction()`、批量写入 `createMany` / `updateMany` / `upsertMany`；
- 游标分页 `findPage()`、字段投影 `select`、按列计数 `count(_, { column })`；
- 实例句柄 `User.db`（做 JOIN）与 `User.fields`（反射字段），方法可直接解构（2.1.0 新增）；
- `db.model()` 幂等：同名同定义重复调用返回同一实例，不再抛 `InvalidModelError`（2.1.0 新增）；
- 约束错误细分：`UniqueConstraintError` / `NotNullConstraintError` / `ForeignKeyConstraintError`。

## 开发

```bash
npm run typecheck   # TypeScript 编译检查（含 tests/type-check.ts 编译期断言）
npm test            # 编译检查 + 全部单元测试（node:test，无需新增依赖）
npm run build       # tsup 构建 dist/（CJS + ESM + 类型声明）
npm run dev         # 运行 example.ts：18 个小节依次覆盖全部 API，可当可执行的速查表
npm run stress      # 压力测试：多进程初始化竞态 / 吞吐 / 20 万行规模 / 并发写 / 锁竞争 / 长稳 / 崩溃恢复 / 资源回收
```

压力测试可用 `npm run stress -- scale soak` 只跑指定场景，报告写入 `.workbuddy/stress/`（已加入 `.gitignore`）。

测试覆盖：内存数据库、自动建表、全部 CRUD（`update` / `delete` 返回值包含整行）、
条件查询（含托管列 `id` / `createdAt` / `updatedAt` 作条件与排序字段、大小写规范化）、
排序与分页（含按主键排序、游标分页、NULL 排序）、单行读取（`findOne` / `exists` / `findByIds`，含超长主键列表分批）、
关键字搜索（大小写、字段限制、通配符、注入防护）、参数绑定与特殊字符、多模型共享连接、文件持久化、
字段同步与删除、自动时间戳（含旧表迁移）、关闭后拒绝操作、事务（提交 / 回滚 / 嵌套拒绝）、
条件操作符（范围 / 集合 / 区间 / 判空 / 超长 IN 拆分）、批量写入（分批、原子性、字段集合校验）、
`deleteMany` 无参拒绝与 `clear()`、upsert（含按主键冲突目标）、字段投影、按列计数、约束错误细分、
并发首次打开只读恢复、非法参数拒绝、编译期类型检查等 186 个用例，全部可重复运行，不污染任何已有数据库文件。

## 暂未实现（第一版范围外）

- 表关联与 JOIN 查询
- 复杂的 WHERE 条件构造器（OR / NOT 嵌套逻辑树、LIKE 条件——目前只有单字段操作符组合，之间为 AND）
- 索引声明（`CREATE INDEX`）与查询计划提示
- 完整的数据库迁移（字段重命名、类型修改、索引与约束管理等；目前仅支持新增字段的自动补齐和多余字段的手动删除）
- 关系映射与懒加载
- 事件系统、插件系统、缓存机制
- Web 管理界面、生命周期钩子、CRUD 代码生成器

### 外键行为

本库**不生成**外键（字段类型只有 `TEXT` / `INTEGER` / `REAL` / `BLOB`，没有 `references` 选项），
但 `node:sqlite` 默认开启 `PRAGMA foreign_keys`，因此你手动建的外键会真实生效：

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS "posts" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "createdAt" TEXT,
    "updatedAt" TEXT,
    "userId" INTEGER REFERENCES "users"("id") ON DELETE CASCADE
  ) STRICT
`);
// 之后照常用 db.model('Post', { tableName: 'posts', fields: { userId: 'INTEGER' } }) 接管
```

实测行为：

- 插入不存在的父行 id → `ForeignKeyConstraintError`；
- 删除仍被引用的父行 → `ForeignKeyConstraintError`（除非子表声明了 `ON DELETE CASCADE` / `SET NULL`）；
- 外键检查发生在**语句级**，因此 `deleteMany` / `clear` 遇到引用会整批回滚，不会留下半删状态。

需要注意：`syncFields()` 只会 `ADD COLUMN`，**不会补外键约束**；表已存在时想加外键，
只能走「新建表 → 复制 → 改名」。

### 没有索引声明能力时怎么建索引

本库**不会**自动创建任何索引——除主键外，`sqlite_master` 里没有其它索引。
`findMany({ email: '…' })`、`findPage({ orderBy: 'age' })` 只要没有对应索引就是全表扫描，
数据量上万后差异明显。目前的做法是用裸 SQL 建：

```typescript
// 必须在 db.model() 之后（表已存在）、且在写入数据之前
db.exec('CREATE INDEX IF NOT EXISTS users_age ON users (age)');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email)');  // upsert({ on: ['email'] }) 需要它
```

引擎侧还有几点限制值得提前知道：

- **`deleteField()` 删不掉被索引引用的列**。SQLite 会直接报错
  `error in index <name> after drop column: no such column`，本库包装为 `SqlModelError`
  （原始信息在 `error.cause` 里）。必须先 `DROP INDEX`，再 `deleteField`：

  ```typescript
  db.exec('DROP INDEX IF EXISTS u_extra');
  User.deleteField('extra');
  ```

- **`syncFields()` 加列不会影响已有索引**（实测索引定义保持原样）。但如果新加的列需要索引，
  得自己补 `CREATE INDEX`——本库不会替你推断哪些列该建索引；
- **`upsert({ on: [...] })` 依赖唯一索引**，忘记建会直接抛
  `SqlModelError`（`cause` 为 `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`）。

想在启动时统一管理索引，可以自己维护一张清单：

```typescript
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS users_age ON users (age)',
  'CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email)',
];

const User = db.model('User', { tableName: 'users', fields: { name: 'TEXT', age: 'INTEGER', email: 'TEXT' } });
for (const sql of INDEXES) db.exec(sql);   // 幂等，重复启动安全
```

想确认某条查询到底走了索引，用 `EXPLAIN QUERY PLAN`：

```typescript
console.log(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM "users" WHERE "email" = ?').all('a@x'));
// 出现 SCAN users 表示全表扫描；SEARCH users USING INDEX ... 才是走索引
```

## License

ISC
