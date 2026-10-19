/**
 * ormlet 压力测试
 *
 * 覆盖场景：
 *   startup     8 个进程同时初始化同一个空库（多实例同时启动的竞态）
 *   throughput  内存库 / 文件库的 CRUD 吞吐与延迟分位数
 *   scale       20 万行数据量下的查询、分页、搜索性能
 *   concurrency 4 个进程并发写同一文件 + 并发读（WAL 读写互不阻塞）
 *   lock        锁竞争下的等待、快速失败与事件循环阻塞时长
 *   soak        持续混合读写 30 秒，观察内存 / WAL 体积 / 数据一致性
 *   recovery    写入过程中 SIGKILL，重开后完整性校验
 *   resources   反复 open/close 的资源回收
 *
 * 用法：
 *   npm run stress              # 全部场景
 *   npm run stress -- scale     # 只跑指定场景（可多个）
 *
 * 产物：控制台摘要 + .workbuddy/stress/report-<时间戳>.md + 同名 .json
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Database, LockTimeoutError } from '../src/index.js';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = join(SCRIPT, '..', '..');
const OUT_DIR = join(ROOT, '.workbuddy', 'stress');
const RUN_DIR = join(OUT_DIR, `run-${Date.now()}`);

type Row = Record<string, unknown>;
interface Sample {
  label: string;
  ops: number;
  ms: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
interface ScenarioResult {
  name: string;
  ok: boolean;
  ms: number;
  samples: Sample[];
  checks: Check[];
  notes: string[];
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------- 工具

function now(): number {
  return performance.now();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** 逐次计时执行，返回吞吐与延迟分位数 */
function measure(label: string, ops: number, fn: (i: number) => void): Sample {
  const latencies = new Array<number>(ops);
  const started = now();
  for (let i = 0; i < ops; i++) {
    const t0 = now();
    fn(i);
    latencies[i] = now() - t0;
  }
  const ms = now() - started;
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    label,
    ops,
    ms,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function fmt(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function mb(bytes: number): number {
  return bytes / 1024 / 1024;
}

function rssMb(): number {
  return mb(process.memoryUsage().rss);
}

/** 触发一次 GC（脚本以 --expose-gc 启动时可用） */
function gc(): void {
  const collect = (globalThis as { gc?: () => void }).gc;
  collect?.();
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

function integrity(path: string): string {
  // 用读写方式打开：崩溃后的 WAL 可能需要恢复，只读连接无法完成恢复
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Row[];
    return rows.map((row) => String(Object.values(row)[0])).join(';');
  } finally {
    db.close();
  }
}

function rawCount(path: string, table: string): number {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number | bigint };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function summarize(samples: Sample[]): void {
  const header = ['operation', 'ops', 'ms', 'ops/s', 'p50', 'p95', 'p99', 'max'];
  const lines = samples.map((s) => [
    s.label,
    String(s.ops),
    fmt(s.ms, 0),
    fmt((s.ops / s.ms) * 1000, 0),
    fmt(s.p50, 2),
    fmt(s.p95, 2),
    fmt(s.p99, 2),
    fmt(s.max, 2),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const render = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(render(header));
  for (const line of lines) console.log(render(line));
}

// ---------------------------------------------------------------- 子进程

interface WorkerReply {
  result?: Record<string, unknown>;
  error?: string;
}

function runWorker(mode: string, args: string[] = [], onLine?: (line: string) => void): Promise<WorkerReply> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', SCRIPT, '--worker', mode, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (reply: WorkerReply): void => {
      if (settled) return;
      settled = true;
      resolve(reply);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      for (const line of chunk.split(/\r?\n/)) {
        if (line) onLine?.(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      err += chunk;
    });
    child.on('error', (error) => finish({ error: String(error) }));
    child.on('close', (code) => {
      const marker = out.lastIndexOf('RESULT ');
      if (marker >= 0) {
        try {
          const json = out.slice(marker + 'RESULT '.length).split(/\r?\n/)[0];
          finish({ result: JSON.parse(json) as Record<string, unknown> });
          return;
        } catch {
          // 落到下面的错误分支
        }
      }
      finish({ error: `worker ${mode} exited with code ${code}: ${err.trim().slice(-500)}` });
    });
  });
}

/** 启动一个持有写锁的进程，等它报告 LOCKED 后返回句柄 */
function startLocker(path: string, holdMs: number): Promise<{ close: () => void; locked: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--import', 'tsx', SCRIPT, '--worker', 'locker', path, String(holdMs)],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let lockedResolve: () => void = () => undefined;
    const locked = new Promise<void>((res) => {
      lockedResolve = res;
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (out.includes('LOCKED')) lockedResolve();
    });
    child.on('error', reject);
    resolve({
      close: () => child.kill('SIGKILL'),
      locked,
    });
  });
}

// ---------------------------------------------------------------- worker 逻辑

async function workerMain(mode: string, args: string[]): Promise<void> {
  const emit = (payload: Record<string, unknown>): void => {
    process.stdout.write(`RESULT ${JSON.stringify(payload)}\n`);
  };

  if (mode === 'locker') {
    const [path, hold] = args;
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO lock_probe (note) VALUES (?)').run('holding');
    process.stdout.write('LOCKED\n');
    await new Promise((resolve) => setTimeout(resolve, Number(hold)));
    db.exec('COMMIT');
    db.close();
    emit({ released: true });
    return;
  }

  if (mode === 'writer') {
    const [path, countText, table] = args;
    const count = Number(countText);
    const db = new Database(path);
    const model = db.model('Load', {
      tableName: table,
      fields: { name: 'TEXT', age: 'INTEGER', score: 'REAL', payload: 'TEXT' },
    });
    const latencies: number[] = [];
    let errors = 0;
    let created = 0;
    let last = 0;
    for (let i = 0; i < count; i++) {
      const t0 = now();
      try {
        if (i % 5 === 4) {
          model.findMany(undefined, { limit: 10 });
        } else {
          const row = model.create({
            name: `worker_${process.pid}_${i}`,
            age: i % 90,
            score: i * 0.5,
            payload: 'x'.repeat(64),
          });
          created += 1;
          if (i % 4 === 0) model.update(row.id, { age: (i % 90) + 1 });
        }
      } catch (error) {
        errors += 1;
        if (errors <= 3) process.stdout.write(`ERR ${(error as Error).name}: ${(error as Error).message}\n`);
      }
      latencies.push(now() - t0);
      last = i + 1;
    }
    const rows = model.count();
    db.close();
    latencies.sort((a, b) => a - b);
    emit({
      pid: process.pid,
      attempted: last,
      created,
      rows,
      errors,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies[latencies.length - 1] ?? 0,
    });
    return;
  }

  if (mode === 'reader') {
    const [path, table, msText] = args;
    const deadline = now() + Number(msText);
    const db = new Database(path);
    const model = db.model('Load', { tableName: table, fields: { name: 'TEXT', age: 'INTEGER', score: 'REAL', payload: 'TEXT' } });
    let reads = 0;
    let errors = 0;
    let maxLatency = 0;
    while (now() < deadline) {
      const t0 = now();
      try {
        model.findById(1 + (reads % 1000));
        model.count();
      } catch {
        errors += 1;
      }
      maxLatency = Math.max(maxLatency, now() - t0);
      reads += 1;
    }
    db.close();
    emit({ reads, errors, maxLatency });
    return;
  }

  if (mode === 'startup') {
    const [path, startAtText] = args;
    const startAt = Number(startAtText);
    // 所有进程在同一时刻开始「打开空库 + 注册模型」，把初始化竞态放到最大
    while (Date.now() < startAt) {
      /* spin */
    }
    try {
      const db = new Database(path);
      const model = db.model('Startup', { tableName: 'startup', fields: { name: 'TEXT', n: 'INTEGER' } });
      model.create({ name: `p${process.pid}`, n: 1 });
      const rows = model.count();
      db.close();
      emit({ ok: true, rows });
    } catch (error) {
      emit({ ok: false, error: `${(error as Error).name}: ${(error as Error).message}` });
    }
    return;
  }

  if (mode === 'crash-writer') {
    const [path, table] = args;
    const db = new Database(path);
    const model = db.model('Crash', { tableName: table, fields: { name: 'TEXT', seq: 'INTEGER' } });
    for (let i = 0; ; i++) {
      model.create({ name: `crash_${i}`, seq: i });
      if (i % 50 === 0) process.stdout.write(`PROGRESS ${i}\n`);
    }
  }

  throw new Error(`unknown worker mode: ${mode}`);
}

// ---------------------------------------------------------------- 场景

async function scenarioStartup(): Promise<ScenarioResult> {
  const started = now();
  const samples: Sample[] = [];
  const checks: Check[] = [];
  const notes: string[] = [];
  const PROCESSES = 8;
  const ROUNDS = 2;

  for (let round = 1; round <= ROUNDS; round++) {
    const dir = join(RUN_DIR, 'startup', `round-${round}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'fresh.db');
    const roundStart = now();
    const startAt = Date.now() + 2_500;
    const replies = await Promise.all(
      Array.from({ length: PROCESSES }, () => runWorker('startup', [path, String(startAt)])),
    );
    const ms = now() - roundStart;
    const succeeded = replies.filter((r) => r.result?.ok === true).length;
    const failures = replies
      .map((r) => (r.error !== undefined ? r.error : r.result?.ok === false ? String(r.result.error) : ''))
      .filter((text) => text.length > 0);
    const rows = rawCount(path, 'startup');
    const checkResult = integrity(path);

    checks.push(
      check(
        `第 ${round} 轮全部进程初始化成功`,
        succeeded === PROCESSES,
        `${succeeded}/${PROCESSES}（含 ${fmt(ms / 1000, 2)}s 对齐等待）${failures.length > 0 ? ` — ${failures[0]}` : ''}`,
      ),
    );
    checks.push(check(`第 ${round} 轮写入完整`, rows === PROCESSES, `${rows} 行 / ${PROCESSES} 次`));
    checks.push(check(`第 ${round} 轮 integrity_check`, checkResult === 'ok', checkResult));
  }

  notes.push(
    `${PROCESSES} 个进程在同一时刻打开同一个全新数据库文件并注册模型；` +
      '这是多实例同时部署 / 容器同时启动时最容易踩到的竞态',
  );
  notes.push('该场景曾稳定复现「attempt to write a readonly database」：连接被 SQLite 判为只读，重试无效，需重开连接');
  return {
    name: 'startup',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples,
    checks,
    notes,
  };
}

function scenarioThroughput(): ScenarioResult {
  const started = now();
  const samples: Sample[] = [];
  const checks: Check[] = [];
  const notes: string[] = [];

  const mem = new Database(':memory:');
  const Mem = mem.model('Bench', {
    tableName: 'bench',
    fields: { name: 'TEXT', age: 'INTEGER', score: 'REAL', note: 'TEXT' },
  });

  samples.push(
    measure('mem create', 50_000, (i) =>
      Mem.create({ name: `user_${i}`, age: i % 100, score: i * 1.5, note: 'n' }),
    ),
  );
  samples.push(measure('mem findById', 50_000, (i) => Mem.findById((i % 50_000) + 1)));
  samples.push(measure('mem findMany(where)', 5_000, (i) => Mem.findMany({ age: i % 100 })));
  samples.push(
    measure('mem paginate limit20', 5_000, (i) =>
      Mem.findMany(undefined, { limit: 20, offset: (i % 200) * 20 }),
    ),
  );
  samples.push(measure('mem search LIKE', 500, (i) => Mem.search(`user_${i % 1000}`, { limit: 20 })));
  samples.push(measure('mem count', 2_000, () => Mem.count()));
  samples.push(measure('mem update', 20_000, (i) => Mem.update((i % 40_000) + 1, { age: i % 50 })));
  samples.push(measure('mem delete', 10_000, (i) => Mem.delete((i % 20_000) + 1)));
  const memRemaining = Mem.count();
  mem.close();
  checks.push(check('内存库计数一致', memRemaining === 50_000 - 10_000, `剩余 ${memRemaining} 行`));

  const dir = join(RUN_DIR, 'throughput');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'bench.db');
  const fileDb = new Database(path);
  const File = fileDb.model('Bench', {
    tableName: 'bench',
    fields: { name: 'TEXT', age: 'INTEGER', score: 'REAL', note: 'TEXT' },
  });
  samples.push(
    measure('file create (WAL)', 5_000, (i) =>
      File.create({ name: `user_${i}`, age: i % 100, score: i * 1.5, note: 'n' }),
    ),
  );
  samples.push(measure('file findById', 5_000, (i) => File.findById((i % 5_000) + 1)));
  samples.push(measure('file findMany(where)', 2_000, (i) => File.findMany({ age: i % 100 })));
  samples.push(measure('file update', 2_000, (i) => File.update((i % 4_000) + 1, { age: i % 50 })));
  samples.push(measure('file search LIKE', 300, (i) => File.search(`user_${i % 500}`, { limit: 20 })));
  samples.push(measure('file delete', 1_000, (i) => File.delete((i % 2_000) + 1)));

  const fileRows = File.count();
  const dbSize = fileSize(path);
  const walSize = fileSize(`${path}-wal`);
  fileDb.close();
  const walAfterClose = fileSize(`${path}-wal`);
  const shmAfterClose = fileSize(`${path}-shm`);
  checks.push(check('文件库计数一致', fileRows === 5_000 - 1_000, `剩余 ${fileRows} 行`));
  checks.push(check('close() 后 WAL 已回收', walAfterClose === 0, `-wal ${walAfterClose} B, -shm ${shmAfterClose} B`));
  checks.push(
    check(
      '文件库插入吞吐',
      (samples.find((s) => s.label === 'file create (WAL)')!.ops /
        samples.find((s) => s.label === 'file create (WAL)')!.ms) *
        1000 >
        200,
      `${fmt(
        (samples.find((s) => s.label === 'file create (WAL)')!.ops /
          samples.find((s) => s.label === 'file create (WAL)')!.ms) *
          1000,
        0,
      )} ops/s（每次写入独立事务并 fsync）`,
    ),
  );
  notes.push(
    `文件库插入受限于「每条记录一次提交 + fsync」，WAL 体积 ${fmt(mb(walSize), 2)} MB，数据库 ${fmt(mb(dbSize), 2)} MB`,
  );
  notes.push('内存库吞吐代表 SQL 编译 / 结果映射的纯开销（每次操作都重新 prepare，无语句缓存）');

  return {
    name: 'throughput',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples,
    checks,
    notes,
    data: { memRemaining, fileRows, dbSize, walSize },
  };
}

function scenarioScale(): ScenarioResult {
  const started = now();
  const samples: Sample[] = [];
  const checks: Check[] = [];
  const notes: string[] = [];
  const ROWS = 200_000;
  const dir = join(RUN_DIR, 'scale');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'scale.db');

  // 先用库本身建表，再用原生连接在一个事务里灌数据（避免 20 万次 fsync）
  const setup = new Database(path);
  setup.model('Scale', {
    tableName: 'scale',
    fields: { name: 'TEXT', email: 'TEXT', age: 'INTEGER', score: 'REAL' },
  });
  setup.close();

  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  const seedStart = now();
  raw.exec('BEGIN');
  const insert = raw.prepare('INSERT INTO "scale" ("createdAt","updatedAt","name","email","age","score") VALUES (?,?,?,?,?,?)');
  const stamp = new Date().toISOString();
  for (let i = 0; i < ROWS; i++) {
    insert.run(stamp, stamp, `user_${String(i).padStart(6, '0')}`, `user${i}@example.com`, i % 120, i * 0.25);
  }
  raw.exec('COMMIT');
  const seedMs = now() - seedStart;
  raw.close();

  const db = new Database(path);
  const Scale = db.model('Scale', {
    tableName: 'scale',
    fields: { name: 'TEXT', email: 'TEXT', age: 'INTEGER', score: 'REAL' },
  });

  samples.push(measure('scale count()', 50, () => Scale.count()));
  samples.push(measure('scale findById', 2_000, (i) => Scale.findById(1 + (i % ROWS))));
  samples.push(
    measure('scale page offset 0', 500, () => Scale.findMany(undefined, { limit: 20, offset: 0 })),
  );
  samples.push(
    measure('scale page offset 100k', 200, () =>
      Scale.findMany(undefined, { limit: 20, offset: 100_000 }),
    ),
  );
  samples.push(
    measure('scale page offset 199k', 200, () =>
      Scale.findMany(undefined, { limit: 20, offset: 199_000 }),
    ),
  );
  samples.push(
    measure('scale filter age (no index)', 100, () =>
      Scale.findMany({ age: 42 }, { limit: 20 }),
    ),
  );
  samples.push(
    measure('scale sort by name (no index)', 50, () =>
      Scale.findMany(undefined, { orderBy: 'name', order: 'ASC', limit: 20 }),
    ),
  );
  samples.push(measure('scale search LIKE', 50, () => Scale.search('user_19999', { limit: 20 })));
  samples.push(measure('scale count(keyword)', 50, () => Scale.count(undefined, { keyword: 'user_19999' })));

  // 全表加载：调用方最容易踩到的内存场景
  gc();
  const rssBeforeAll = rssMb();
  const allStart = now();
  const allRows = Scale.findMany();
  const fullMs = now() - allStart;
  const rssAfterAll = rssMb();
  const allLength = allRows.length;
  allRows.length = 0;

  const total = Scale.count();
  const page = Scale.findMany(undefined, { limit: 5, orderBy: 'name', order: 'ASC' });
  const searched = Scale.search('user_19999');
  const dbSize = fileSize(path);
  db.close();
  gc();

  checks.push(check('数据总量', total === ROWS, `${total} 行`));
  checks.push(check('全表加载行数正确', allLength === ROWS, `${allLength} 行 / 耗时 ${fmt(fullMs, 0)}ms`));
  checks.push(
    check('全表加载内存增量 < 300MB', rssAfterAll - rssBeforeAll < 300, `+${fmt(rssAfterAll - rssBeforeAll, 1)} MB`),
  );
  checks.push(check('深分页结果正确', page.length === 5, `返回 ${page.length} 行`));
  checks.push(check('搜索命中', searched.length >= 1, `命中 ${searched.length} 行`));
  const p99Page = samples.find((s) => s.label === 'scale page offset 0')!.p99;
  const p99Deep = samples.find((s) => s.label === 'scale page offset 199k')!.p99;
  checks.push(check('首页查询 p99 < 50ms', p99Page < 50, `p99 ${fmt(p99Page, 2)}ms`));
  checks.push(check('深分页 p99 < 300ms', p99Deep < 300, `p99 ${fmt(p99Deep, 2)}ms`));
  notes.push(`20 万行灌库（单事务、synchronous=NORMAL）耗时 ${fmt(seedMs, 0)}ms，库文件 ${fmt(mb(dbSize), 1)} MB`);
  notes.push(
    `不带 limit 的 findMany() 一次加载 ${allLength} 行耗时 ${fmt(fullMs, 0)}ms，RSS +${fmt(rssAfterAll - rssBeforeAll, 1)} MB，生产代码应始终分页`,
  );
  notes.push('无索引字段上的过滤 / 排序 / LIKE 均为全表扫描，延迟随行数线性增长');

  return {
    name: 'scale',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples,
    checks,
    notes,
    data: { rows: total, seedMs, dbSize, fullLoadMs: fullMs, fullLoadRss: rssAfterAll - rssBeforeAll },
  };
}

async function scenarioConcurrency(): Promise<ScenarioResult> {
  const started = now();
  const samples: Sample[] = [];
  const checks: Check[] = [];
  const notes: string[] = [];
  const WORKERS = 4;
  const PER_WORKER = 500;
  const dir = join(RUN_DIR, 'concurrency');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'concurrent.db');

  const bootstrap = new Database(path);
  bootstrap
    .model('Load', {
      tableName: 'load',
      fields: { name: 'TEXT', age: 'INTEGER', score: 'REAL', payload: 'TEXT' },
    })
    .count();
  bootstrap.close();

  // 写者并发 + 父进程持续读（验证 WAL 下读写互不阻塞）
  let reading = true;
  const readPromise = new Promise<{ reads: number; errors: number; maxLatency: number }>((resolve) => {
    const db = new Database(path);
    const model = db.model('Load', {
      tableName: 'load',
      fields: { name: 'TEXT', age: 'INTEGER', score: 'REAL', payload: 'TEXT' },
    });
    let reads = 0;
    let errors = 0;
    let maxLatency = 0;
    const tick = (): void => {
      if (!reading) {
        db.close();
        resolve({ reads, errors, maxLatency });
        return;
      }
      const t0 = now();
      try {
        model.findById(1 + (reads % 500));
        model.count();
      } catch {
        errors += 1;
      }
      maxLatency = Math.max(maxLatency, now() - t0);
      reads += 1;
      setImmediate(tick);
    };
    tick();
  });

  const writeStart = now();
  const replies = await Promise.all(
    Array.from({ length: WORKERS }, () => runWorker('writer', [path, String(PER_WORKER), 'load'])),
  );
  const writeMs = now() - writeStart;
  reading = false;

  const readers = await readPromise;
  const workers = replies.map((r) => r.result ?? {});
  const failures = replies.filter((r) => r.error !== undefined);
  const errors = workers.reduce((sum, w) => sum + Number(w.errors ?? 0), 0);
  const totalAttempted = workers.reduce((sum, w) => sum + Number(w.attempted ?? 0), 0);
  const totalCreated = workers.reduce((sum, w) => sum + Number(w.created ?? 0), 0);
  const db = new Database(path);
  const model = db.model('Load', {
    tableName: 'load',
    fields: { name: 'TEXT', age: 'INTEGER', score: 'REAL', payload: 'TEXT' },
  });
  const rows = model.count();
  db.close();

  const writeSample: Sample = {
    label: `concurrent write (${WORKERS} processes)`,
    ops: totalAttempted,
    ms: writeMs,
    p50: Math.max(...workers.map((w) => Number(w.p50 ?? 0))),
    p95: Math.max(...workers.map((w) => Number(w.p95 ?? 0))),
    p99: Math.max(...workers.map((w) => Number(w.p99 ?? 0))),
    max: Math.max(...workers.map((w) => Number(w.max ?? 0))),
  };
  samples.push(writeSample);

  checks.push(check('无子进程异常退出', failures.length === 0, failures.map((f) => f.error).join(' | ') || 'ok'));
  checks.push(check('无写锁错误', errors === 0, `${errors} 次错误`));
  checks.push(
    check('写入行数完整', rows === totalCreated, `表中 ${rows} 行 / 实际插入 ${totalCreated} 次`),
  );
  checks.push(check('并发读无错误', readers.errors === 0, `读 ${readers.reads} 次，错误 ${readers.errors} 次`));
  checks.push(
    check('并发读最大延迟 < 500ms', readers.maxLatency < 500, `${fmt(readers.maxLatency, 1)}ms`),
  );
  const checkResult = integrity(path);
  checks.push(check('integrity_check', checkResult === 'ok', checkResult));
  notes.push(
    `${WORKERS} 进程 × ${PER_WORKER} 次操作（80% 插入、20% 读）总耗时 ${fmt(writeMs, 0)}ms，` +
      `实际插入 ${totalCreated} 行，写吞吐 ${fmt((totalCreated / writeMs) * 1000, 0)} ops/s；并发读 ${readers.reads} 次未报错`,
  );
  notes.push('所有进程共享同一 WAL 文件，busy_timeout 默认 5000ms 吸收瞬时锁冲突');

  return {
    name: 'concurrency',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples,
    checks,
    notes,
    data: { workers, readers, rows },
  };
}

async function scenarioLock(): Promise<ScenarioResult> {
  const started = now();
  const samples: Sample[] = [];
  const checks: Check[] = [];
  const notes: string[] = [];
  const dir = join(RUN_DIR, 'lock');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'lock.db');
  const HOLD_MS = 3_000;

  const db = new Database(path);
  const model = db.model('Lock', { tableName: 'lock', fields: { name: 'TEXT' } });
  db.close();

  const locker = await startLocker(path, HOLD_MS);
  await locker.locked;

  // 1) 非阻塞探测
  const probeDb = new Database(path);
  const Probe = probeDb.model('Lock', { tableName: 'lock', fields: { name: 'TEXT' } });
  const lockedDetected = probeDb.isLocked();

  // 2) busyTimeout = 0 立即失败
  probeDb.setBusyTimeout(0);
  const fastStart = now();
  let failFastName = '';
  try {
    Probe.create({ name: 'blocked' });
  } catch (error) {
    failFastName = (error as Error).name;
  }
  const failFastMs = now() - fastStart;

  // 3) 短等待窗口：按时超时
  probeDb.setBusyTimeout(150);
  const shortStart = now();
  let shortName = '';
  try {
    Probe.create({ name: 'blocked' });
  } catch (error) {
    shortName = (error as Error).name;
  }
  const shortMs = now() - shortStart;

  // 4) 长等待：锁释放后写入成功，同时测量事件循环最长阻塞
  probeDb.setBusyTimeout(5_000);
  let maxStall = 0;
  let lastTick = now();
  const timer = setInterval(() => {
    const t = now();
    maxStall = Math.max(maxStall, t - lastTick);
    lastTick = t;
  }, 20);
  lastTick = now();
  const waitStart = now();
  Probe.create({ name: 'waited' });
  const waitMs = now() - waitStart;
  clearInterval(timer);
  maxStall = Math.max(maxStall, waitMs);

  const lockedAfter = probeDb.isLocked();
  const busyTimeout = probeDb.busyTimeout;
  const rows = Probe.count();
  probeDb.close();

  samples.push({
    label: 'create blocked until timeout(150ms)',
    ops: 1,
    ms: shortMs,
    p50: shortMs,
    p95: shortMs,
    p99: shortMs,
    max: shortMs,
  });
  samples.push({
    label: 'create waiting for lock release',
    ops: 1,
    ms: waitMs,
    p50: waitMs,
    p95: waitMs,
    p99: waitMs,
    max: waitMs,
  });

  checks.push(check('isLocked() 能探测到锁', lockedDetected, `返回 ${lockedDetected}`));
  checks.push(
    check('busyTimeout=0 快速失败', failFastMs < 100 && failFastName === 'LockTimeoutError', `${fmt(failFastMs, 1)}ms, ${failFastName}`),
  );
  checks.push(
    check(
      '短等待按时超时',
      shortName === 'LockTimeoutError' && shortMs >= 120 && shortMs < 800,
      `${fmt(shortMs, 0)}ms, ${shortName}`,
    ),
  );
  checks.push(check('锁释放后写入成功', waitMs < HOLD_MS + 1_000, `等待 ${fmt(waitMs, 0)}ms`));
  checks.push(check('锁释放后 isLocked() 恢复', lockedAfter === false, `返回 ${lockedAfter}`));
  checks.push(check('busyTimeout 已还原', busyTimeout === 5_000, `${busyTimeout}ms`));
  checks.push(check('等待期间的数据写入正确', rows === 1, `${rows} 行`));
  notes.push(
    `同步 API 的等待会阻塞事件循环：本次最长阻塞 ${fmt(maxStall, 0)}ms，与 busyTimeout 上限一致；` +
      '对延迟敏感的场景应先 isLocked() 或用 setBusyTimeout(0)',
  );
  notes.push('错误类型为 LockTimeoutError，可直接区分锁竞争与其它错误');
  locker.close();

  return {
    name: 'lock',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples,
    checks,
    notes,
    data: { failFastMs, shortMs, waitMs, maxStall },
  };
}

async function scenarioSoak(): Promise<ScenarioResult> {
  const started = now();
  const samples: Sample[] = [];
  const checks: Check[] = [];
  const notes: string[] = [];
  const DURATION = Number(process.env.STRESS_SOAK_MS ?? 30_000);
  const dir = join(RUN_DIR, 'soak');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'soak.db');

  const db = new Database(path);
  const Users = db.model('User', {
    tableName: 'users',
    fields: { name: 'TEXT', email: 'TEXT', age: 'INTEGER', score: 'REAL' },
  });
  const Events = db.model('Event', {
    tableName: 'events',
    fields: { kind: 'TEXT', payload: 'TEXT', weight: 'INTEGER' },
  });
  const Metrics = db.model('Metric', {
    tableName: 'metrics',
    fields: { label: 'TEXT', value: 'REAL' },
  });

  gc();
  const rssStart = rssMb();
  const heapStart = mb(process.memoryUsage().heapUsed);
  let maxRss = rssStart;
  let maxWal = 0;
  let ops = 0;
  let errors = 0;
  const errorSamples: string[] = [];
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let searched = 0;
  let found = 0;
  const latencyWindows: number[] = [];
  let windowStart = now();
  let windowMax = 0;
  let globalMax = 0;
  let globalMaxOp = 0;
  let lastSample = started;
  const rssSeries: Array<{ t: number; rss: number; wal: number }> = [];

  while (now() - started < DURATION) {
    const t0 = now();
    try {
      const step = ops % 10;
      if (step < 5) {
        const row = Users.create({
          name: `soak_${ops}`,
          email: `soak${ops}@example.com`,
          age: ops % 90,
          score: ops * 0.5,
        });
        created += 1;
        if (ops % 3 === 0) {
          Users.update(row.id, { age: (ops % 90) + 1 });
          updated += 1;
        }
        if (ops % 7 === 0) {
          Users.delete(row.id);
          deleted += 1;
        }
      } else if (step < 7) {
        Events.create({ kind: `k${ops % 20}`, payload: 'p'.repeat(32), weight: ops % 100 });
      } else if (step === 7) {
        found += Users.findById(1 + (ops % 50)) === undefined ? 0 : 1;
      } else if (step === 8) {
        searched += Users.search(`soak_${ops % 100}`, { limit: 10 }).length;
      } else {
        Users.count({ age: ops % 90 });
        Events.count();
        Metrics.create({ label: 'heartbeat', value: ops });
      }
    } catch (error) {
      errors += 1;
      if (errorSamples.length < 5) errorSamples.push(`${(error as Error).name}: ${(error as Error).message}`);
    }
    const elapsed = now() - t0;
    windowMax = Math.max(windowMax, elapsed);
    if (elapsed > globalMax) {
      globalMax = elapsed;
      globalMaxOp = ops;
    }
    latencyWindows.push(elapsed);
    ops += 1;

    if (now() - windowStart >= 1_000) {
      samples.push({
        label: `window ${samples.length + 1}s`,
        ops: latencyWindows.length,
        ms: now() - windowStart,
        p50: percentile([...latencyWindows].sort((a, b) => a - b), 50),
        p95: percentile([...latencyWindows].sort((a, b) => a - b), 95),
        p99: percentile([...latencyWindows].sort((a, b) => a - b), 99),
        max: windowMax,
      });
      latencyWindows.length = 0;
      windowStart = now();
      windowMax = 0;
    }
    if (now() - lastSample >= 1_000) {
      lastSample = now();
      const rss = rssMb();
      maxRss = Math.max(maxRss, rss);
      const wal = fileSize(`${path}-wal`);
      maxWal = Math.max(maxWal, wal);
      rssSeries.push({ t: Math.round((now() - started) / 1000), rss: Number(rss.toFixed(1)), wal });
    }
  }

  const userRows = Users.count();
  const eventRows = Events.count();
  gc();
  const rssEnd = rssMb();
  const heapEnd = mb(process.memoryUsage().heapUsed);
  db.close();

  const checkResult = integrity(path);
  const rssGrowth = rssEnd - rssStart;
  checks.push(check('无运行时错误', errors === 0, `${errors} 次 ${errorSamples.join(' | ')}`));
  checks.push(
    check(
      '写入计数一致',
      userRows === created - deleted,
      `created ${created} - deleted ${deleted} = ${created - deleted}，实际 ${userRows}`,
    ),
  );
  checks.push(check('事件表持续写入', eventRows > 0, `${eventRows} 行`));
  checks.push(check('integrity_check', checkResult === 'ok', checkResult));
  checks.push(check('RSS 增长 < 80MB', rssGrowth < 80, `${fmt(rssStart, 1)} → ${fmt(rssEnd, 1)} MB（+${fmt(rssGrowth, 1)}）`));
  checks.push(check('堆增长 < 40MB', heapEnd - heapStart < 40, `${fmt(heapStart, 1)} → ${fmt(heapEnd, 1)} MB`));
  notes.push(
    `${fmt(DURATION / 1000, 0)} 秒共 ${ops} 次操作（${fmt((ops / (now() - started)) * 1000, 0)} ops/s），` +
      `创建 ${created} / 更新 ${updated} / 删除 ${deleted} / 搜索命中 ${searched}`,
  );
  notes.push(`RSS 峰值 ${fmt(maxRss, 1)} MB，WAL 峰值 ${fmt(mb(maxWal), 2)} MB（自动 checkpoint 生效）`);
  const windowP99 = samples.map((s) => s.p99).sort((a, b) => a - b);
  notes.push(
    `最长单次操作 ${fmt(globalMax, 0)}ms（第 ${globalMaxOp} 次），来自 WAL 自动 checkpoint 刷盘；` +
      `各秒窗口 p99 中位数 ${fmt(percentile(windowP99, 50), 2)}ms`,
  );
  notes.push('每 10 次操作含 1 次 count（3 表）+ 1 次搜索，模拟持续混合负载');

  return {
    name: 'soak',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples,
    checks,
    notes,
    data: { ops, created, updated, deleted, searched, found, errors, rssSeries, maxWal, globalMax, globalMaxOp },
  };
}

async function scenarioRecovery(): Promise<ScenarioResult> {
  const started = now();
  const checks: Check[] = [];
  const notes: string[] = [];
  const dir = join(RUN_DIR, 'recovery');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'crash.db');

  const bootstrap = new Database(path);
  bootstrap.model('Crash', { tableName: 'crash', fields: { name: 'TEXT', seq: 'INTEGER' } }).count();
  bootstrap.close();

  let reported = 0;
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--import', 'tsx', SCRIPT, '--worker', 'crash-writer', path, 'crash'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
    const matches = out.match(/PROGRESS (\d+)/g);
    if (matches) reported = Number(matches[matches.length - 1].split(' ')[1]);
  });
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('close', resolve));

  const walBefore = fileSize(`${path}-wal`);
  const checkResult = integrity(path);
  const rows = rawCount(path, 'crash');

  const db = new Database(path);
  const Crash = db.model('Crash', { tableName: 'crash', fields: { name: 'TEXT', seq: 'INTEGER' } });
  const sample = Crash.findMany(undefined, { limit: 5 });
  const seqs = sample.map((row) => row.seq);
  const writable = Crash.create({ name: 'after_crash', seq: -1 });
  const afterWrite = Crash.findById(writable.id);
  db.close();

  const walAfter = fileSize(`${path}-wal`);
  checks.push(check('SIGKILL 后完整性校验通过', checkResult === 'ok', checkResult));
  checks.push(check('已提交数据未丢失', rows >= reported, `崩溃前报告 ${reported} 行，恢复后 ${rows} 行`));
  checks.push(check('恢复后可继续写入', afterWrite?.name === 'after_crash', '新写入读回正常'));
  checks.push(check('行结构完整', seqs.every((s) => typeof s === 'number'), `样本 seq: ${seqs.slice(0, 5).join(',')}`));
  notes.push(`写入进程被 SIGKILL 终止时已提交 ${rows} 行，重开后 integrity_check = ${checkResult}`);
  notes.push(`崩溃时残留 WAL ${fmt(mb(walBefore), 2)} MB，重开时自动重放，关闭后归零（${walAfter} B）`);
  notes.push('每条写入都是独立事务，崩溃最多丢掉最后一个未提交事务，不会留下半条记录');

  return {
    name: 'recovery',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples: [],
    checks,
    notes,
    data: { reported, rows, walBefore, walAfter },
  };
}

function scenarioResources(): ScenarioResult {
  const started = now();
  const samples: Sample[] = [];
  const checks: Check[] = [];
  const notes: string[] = [];
  const CYCLES = 200;
  const dir = join(RUN_DIR, 'resources');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'cycles.db');

  gc();
  const rssStart = rssMb();
  const heapStart = mb(process.memoryUsage().heapUsed);
  const handlesStart = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length;
  const delays: number[] = [];

  let lastRowCount = 0;
  for (let i = 0; i < CYCLES; i++) {
    const t0 = now();
    const db = new Database(path);
    const model = db.model('Cycle', { tableName: 'cycles', fields: { name: 'TEXT', n: 'INTEGER' } });
    model.create({ name: `cycle_${i}`, n: i });
    model.findById(1 + (i % 10));
    lastRowCount = model.count();
    db.close();
    const elapsed = now() - t0;
    delays.push(elapsed);
    if (i % 5 === 0) samples.push({ label: `cycle ${i}`, ops: 1, ms: elapsed, p50: elapsed, p95: elapsed, p99: elapsed, max: elapsed });
  }
  gc();
  const rssEnd = rssMb();
  const heapEnd = mb(process.memoryUsage().heapUsed);
  const handlesEnd = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length;
  const walLeft = fileSize(`${path}-wal`);
  const shmLeft = fileSize(`${path}-shm`);
  const sorted = [...delays].sort((a, b) => a - b);
  samples.push({
    label: `open/model/count/close x${CYCLES}`,
    ops: CYCLES,
    ms: delays.reduce((a, b) => a + b, 0),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  });

  checks.push(check('行数随周期增长', lastRowCount === CYCLES, `${lastRowCount} 行 / ${CYCLES} 次`));
  checks.push(check('活动句柄未泄漏', handlesEnd <= handlesStart, `${handlesStart} → ${handlesEnd}`));
  checks.push(check('RSS 增长 < 40MB', rssEnd - rssStart < 40, `${fmt(rssStart, 1)} → ${fmt(rssEnd, 1)} MB`));
  checks.push(check('堆增长 < 30MB', heapEnd - heapStart < 30, `${fmt(heapStart, 1)} → ${fmt(heapEnd, 1)} MB`));
  checks.push(check('无残留 -wal / -shm', walLeft === 0 && shmLeft === 0, `-wal ${walLeft} B, -shm ${shmLeft} B`));
  notes.push(`${CYCLES} 次 open → model → create → find → count → close，平均 ${fmt(delays.reduce((a, b) => a + b, 0) / CYCLES, 2)}ms/次`);
  notes.push('每次循环都注册模型并触发建表 / 字段同步，覆盖 DDL 路径');

  return {
    name: 'resources',
    ok: checks.every((c) => c.ok),
    ms: now() - started,
    samples,
    checks,
    notes,
    data: { cycles: CYCLES, rssStart, rssEnd, handlesStart, handlesEnd, lastRowCount },
  };
}

// ---------------------------------------------------------------- 报告

function toMarkdown(results: ScenarioResult[], meta: Record<string, string>): string {
  const lines: string[] = [];
  lines.push('# ormlet 压力测试报告');
  lines.push('');
  lines.push(`- 日期：${meta.date}`);
  lines.push(`- 环境：${meta.env}`);
  lines.push(`- 版本：${meta.version}`);
  lines.push('');
  const passed = results.filter((r) => r.ok).length;
  lines.push(`**结论：${passed}/${results.length} 个场景通过**`);
  lines.push('');
  lines.push('| 场景 | 结果 | 耗时 | 检查项 |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.ok).length;
    lines.push(`| ${r.name} | ${r.ok ? '通过' : `失败（${failed} 项）`} | ${fmt(r.ms / 1000, 1)}s | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`);
  }
  lines.push('');

  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push('');
    if (r.samples.length > 0) {
      lines.push('| 操作 | 次数 | 总耗时(ms) | ops/s | p50(ms) | p95(ms) | p99(ms) | max(ms) |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const s of r.samples) {
        lines.push(
          `| ${s.label} | ${s.ops} | ${fmt(s.ms, 0)} | ${fmt((s.ops / s.ms) * 1000, 0)} | ${fmt(s.p50, 2)} | ${fmt(s.p95, 2)} | ${fmt(s.p99, 2)} | ${fmt(s.max, 2)} |`,
        );
      }
      lines.push('');
    }
    lines.push('检查项：');
    for (const c of r.checks) lines.push(`- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name}：${c.detail}`);
    if (r.notes.length > 0) {
      lines.push('');
      lines.push('备注：');
      for (const n of r.notes) lines.push(`- ${n}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- 入口

async function main(): Promise<void> {
  if (process.argv[2] === '--worker') {
    await workerMain(process.argv[3], process.argv.slice(4));
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(RUN_DIR, { recursive: true });

  const registry: Record<string, () => ScenarioResult | Promise<ScenarioResult>> = {
    startup: scenarioStartup,
    throughput: scenarioThroughput,
    scale: scenarioScale,
    concurrency: scenarioConcurrency,
    lock: scenarioLock,
    soak: scenarioSoak,
    recovery: scenarioRecovery,
    resources: scenarioResources,
  };
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = requested.length > 0 ? requested : Object.keys(registry);
  for (const name of names) {
    if (!(name in registry)) {
      console.error(`未知场景: ${name}（可选: ${Object.keys(registry).join(', ')}）`);
      process.exitCode = 1;
      return;
    }
  }

  const results: ScenarioResult[] = [];
  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    const result = await registry[name]();
    results.push(result);
    if (result.samples.length > 0) summarize(result.samples);
    for (const c of result.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
    for (const n of result.notes) console.log(`  · ${n}`);
    console.log(`  场景耗时 ${fmt(result.ms / 1000, 1)}s → ${result.ok ? '通过' : '失败'}`);
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const cpu = cpus()[0]?.model ?? 'unknown CPU';
  const meta = {
    date: new Date().toISOString(),
    env: `Node ${process.version} / ${process.platform} ${process.arch} / ${cpu} × ${cpus().length}`,
    version: `${pkg.version} (node:sqlite)`,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(OUT_DIR, `report-${stamp}.json`);
  const mdPath = join(OUT_DIR, `report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify({ meta, results }, null, 2));
  writeFileSync(mdPath, toMarkdown(results, meta));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 个场景通过`);
  console.log(`报告: ${mdPath}`);
  console.log(`数据: ${jsonPath}`);
  if (passed !== results.length) process.exitCode = 1;

  // 清理本次运行的临时数据库
  rmSync(RUN_DIR, { recursive: true, force: true });
  if (existsSync(RUN_DIR)) console.log(`临时文件未能清理: ${RUN_DIR}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
