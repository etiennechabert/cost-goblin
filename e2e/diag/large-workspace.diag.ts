/**
 * DIAGNOSTIC, not a test suite — walks every view of the built app on a CLONE
 * of a real workspace and reports, per step: time to settle, queries run (and
 * how many read raw Parquet instead of the rollup), UI/main-thread stalls and
 * memory. Made for workspaces too big for fixtures to imitate: it is how the
 * launch crash on a 46 GB workspace, and the dashboards that never finished
 * loading on it, were found and their fixes checked.
 *
 * It ends when the walk does or when the app dies; it asserts only that the
 * app survived. Everything else is the report it prints and writes to
 * `$TMPDIR/costgoblin-diag/large-workspace-<time>/` (report.json, samples.tsv
 * and each step's query log — SQL with local paths in it, so keep it local).
 *
 * The real workspace is never opened:
 *  - it is cloned first (copy-on-write on APFS and on reflink filesystems, so
 *    instant and free; a plain copy elsewhere) and the app runs on the clone,
 *    in workspace mode under a throwaway userData dir;
 *  - the clone loses its LAN-sharing identity and key, so nothing is served
 *    to peers, and its MCP listener is off;
 *  - telemetry is off unless COSTGOBLIN_DIAG_TELEMETRY=1 keeps the workspace's
 *    own opt-ins. An unpackaged build has no DSN: export COSTGOBLIN_SENTRY_DSN
 *    too if crash reports should be sent. Crashpad uploads a native crash on
 *    the NEXT launch, so a run that died is relaunched briefly to send it;
 *  - the launch goes through launchElectron, so no cloud credentials reach the
 *    app and nothing syncs.
 *
 * Run (after `npm run build --workspace=packages/desktop`):
 *   COSTGOBLIN_DIAG_WORKSPACE="$HOME/Library/Application Support/costgoblin/workspaces/<name>" \
 *     npx playwright test --config playwright.diag.config.ts e2e/diag/large-workspace.diag.ts
 *
 * Options:
 *   COSTGOBLIN_DIAG_PASSES=3        walk the views N times, each with other date ranges (a soak)
 *   COSTGOBLIN_DIAG_MEMORY_GB=4     DuckDB memory limit for the run (default: the app's own)
 *   COSTGOBLIN_DIAG_REBUILD=1       drop the clone's rollup first: time the full pre-aggregation
 *   COSTGOBLIN_DIAG_SETTLE_MS=240000  how long a step may take to finish loading
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { clickNavButton, closeApp, launchElectron, selectDatePreset } from '../helpers.js';

const WORKSPACE = process.env['COSTGOBLIN_DIAG_WORKSPACE'] ?? '';
const PASSES = Math.max(1, Number(process.env['COSTGOBLIN_DIAG_PASSES'] ?? '1'));
const MEMORY_GB = process.env['COSTGOBLIN_DIAG_MEMORY_GB'];
const REBUILD = process.env['COSTGOBLIN_DIAG_REBUILD'] === '1';
const TELEMETRY = process.env['COSTGOBLIN_DIAG_TELEMETRY'] === '1';
const SETTLE_MS = Number(process.env['COSTGOBLIN_DIAG_SETTLE_MS'] ?? '240000');

/** Date ranges per pass: each pass misses the app's result cache and reaches
 *  DuckDB with other shapes. "Last 7 days" is the hourly tier (raw Parquet). */
const PRESETS: readonly (readonly string[])[] = [
  ['Last 90 days', 'Last 365 days', 'Last 7 days', 'Last 30 days'],
  ['Last 14 days', 'Last 180 days', 'Last month', 'Last quarter'],
  ['This month', 'Last year', 'Last 90 days', 'Last 30 days'],
];

/** Sets the date range to a preset. The picker's trigger shows the current
 *  range's label, so once a preset is the range its text is on the page twice
 *  and `selectDatePreset`'s click by text matches both: nothing to click then,
 *  the view already loaded at that range. */
async function pickDatePreset(page: Page, label: string): Promise<void> {
  const current = (await page.locator('button:has(svg.lucide-calendar)').innerText()).trim();
  if (current !== label) await selectDatePreset(page, label);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// The clone
// ---------------------------------------------------------------------------

/** Copy `source` to `dest` sharing its blocks where the filesystem can: the
 *  clone of a 46 GB workspace then takes a tenth of a second and no disk. */
function cloneTree(source: string, dest: string): void {
  try {
    if (process.platform === 'darwin') { execFileSync('cp', ['-cRp', source, dest]); return; }
    if (process.platform === 'linux') { execFileSync('cp', ['-Rp', '--reflink=auto', source, dest]); return; }
  } catch (err) {
    console.warn(`[diag] copy-on-write clone failed (${String(err).split('\n')[0] ?? ''}); copying instead`);
    rmSync(dest, { recursive: true, force: true });
  }
  cpSync(source, dest, { recursive: true, preserveTimestamps: true });
}

interface Clone {
  readonly userData: string;
  readonly workspaceDir: string;
  /** `{data}/{provider}` of the first provider that has raw data. */
  readonly providerDir: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON or YAML file's content when it is an object. Null when the file is
 *  missing, does not parse, or holds anything else. */
function readRecord(path: string, parseText: (text: string) => unknown): Record<string, unknown> | null {
  try {
    const doc = parseText(readFileSync(path, 'utf-8'));
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function writePreferences(workspaceDir: string, memoryGB: string | undefined): void {
  const path = join(workspaceDir, 'state', 'ui-preferences.json');
  const saved = readRecord(path, text => JSON.parse(text)) ?? {};
  const savedPerformance = isRecord(saved['performance']) ? saved['performance'] : undefined;
  const performance = memoryGB === undefined
    ? savedPerformance
    : { ...savedPerformance, memoryLimitGB: Number(memoryGB) };
  const prefs: Record<string, unknown> = {
    ...(TELEMETRY && saved['telemetry'] !== undefined ? { telemetry: saved['telemetry'] } : {}),
    ...(performance === undefined ? {} : { performance }),
    mcp: { enabled: false },
  };
  writeFileSync(path, JSON.stringify(prefs, null, 2));
}

function prepareClone(root: string): Clone {
  const name = basename(WORKSPACE);
  const userData = join(root, 'userdata');
  const workspaceDir = join(userData, 'workspaces', name);
  mkdirSync(workspaceDir, { recursive: true });
  for (const part of ['config', 'data', 'state']) {
    const source = join(WORKSPACE, part);
    if (existsSync(source)) cloneTree(source, join(workspaceDir, part));
    else mkdirSync(join(workspaceDir, part), { recursive: true });
  }
  mkdirSync(join(workspaceDir, 'temp'), { recursive: true });
  // Nothing of this run is served to peers, replayed from an old outbox, or uploaded unasked.
  for (const file of ['config/peer-sharing.json', 'config/peer-identity.json', 'state/telemetry-outbox.jsonl']) {
    rmSync(join(workspaceDir, file), { force: true });
  }
  writePreferences(workspaceDir, MEMORY_GB);
  writeFileSync(join(userData, 'app-state.json'), JSON.stringify({ schemaVersion: 1, lastWorkspace: name }));

  const dataDir = join(workspaceDir, 'data');
  const provider = readdirSync(dataDir, { withFileTypes: true })
    .find(entry => entry.isDirectory() && existsSync(join(dataDir, entry.name, 'raw')));
  const providerDir = provider === undefined ? null : join(dataDir, provider.name);
  if (REBUILD && providerDir !== null) rmSync(join(providerDir, 'rollup'), { recursive: true, force: true });
  return { userData, workspaceDir, providerDir };
}

/** Rollup partitions built vs daily months of raw data, read from disk: the
 *  background build shows nowhere else from outside the app. */
function rollupProgress(providerDir: string | null): { built: number; months: number } | null {
  if (providerDir === null) return null;
  let months = 0;
  try { months = readdirSync(join(providerDir, 'raw')).filter(d => d.startsWith('daily-')).length; } catch { return null; }
  const manifest = readRecord(join(providerDir, 'rollup', 'manifest.json'), text => JSON.parse(text));
  const partitions = manifest !== null && isRecord(manifest['partitions']) ? manifest['partitions'] : {};
  return { built: Object.keys(partitions).length, months };
}

/** The dashboards views.yaml names. None when the file is missing (the app
 *  seeds its defaults, reached through Home) or is not a list of views. */
function dashboardNames(workspaceDir: string): string[] {
  const doc = readRecord(join(workspaceDir, 'config', 'views.yaml'), text => parse(text));
  const views: readonly unknown[] = doc !== null && Array.isArray(doc['views']) ? doc['views'] : [];
  return views
    .map(view => (isRecord(view) ? view['name'] : undefined))
    .filter((name): name is string => typeof name === 'string');
}

// ---------------------------------------------------------------------------
// The app under observation
// ---------------------------------------------------------------------------

interface AppExit { readonly code: number | null; readonly signal: string | null; readonly atS: number }

interface Observed {
  readonly app: ElectronApplication;
  readonly pid: number;
  readonly startedAt: number;
  exit(): AppExit | null;
  /** Rejected IPC handlers the main process printed, cancelled queries aside. */
  handlerErrors(): readonly string[];
  /** WARN and ERROR lines of the app's own log: a rollup month that failed to
   *  build shows here and nowhere in the UI's timings. */
  warnings(): readonly string[];
}

/** The runner's env without the variables that pin the app to a data or a
 *  config directory. With one exported in the shell the app would open that
 *  directory, whatever it is, instead of the clone. */
function envWithoutPinnedDirs(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'COSTGOBLIN_DATA_DIR' || key === 'COSTGOBLIN_CONFIG_DIR') continue;
    env[key] = value;
  }
  return env;
}

async function launchOnClone(clone: Clone, outDir: string, logName: string): Promise<Observed> {
  const startedAt = Date.now();
  const app = await launchElectron({
    inherited: envWithoutPinnedDirs(),
    env: {
      NODE_ENV: 'production',
      COSTGOBLIN_HEADLESS: process.env['COSTGOBLIN_HEADLESS'] === '0' ? '0' : '1',
      COSTGOBLIN_USER_DATA_DIR: clone.userData,
      // Coverage instrumentation would distort what this measures.
      NODE_V8_COVERAGE: '',
    },
  });
  const child = app.process();
  child.stdout?.pipe(createWriteStream(join(outDir, `${logName}.stdout.log`)));
  child.stderr?.pipe(createWriteStream(join(outDir, `${logName}.stderr.log`)));
  const handlerErrors: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line.startsWith('Error occurred in handler for') && !line.includes('Query cancelled')) handlerErrors.push(line.slice(0, 300));
    }
  });
  const warnings: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (/^\[[^\]]+\] (WARN|ERROR) /.test(line)) warnings.push(line.replace(/^\[[^\]]+\] /, '').slice(0, 300));
    }
  });
  let exit: AppExit | null = null;
  child.on('exit', (code, signal) => { exit = { code, signal, atS: (Date.now() - startedAt) / 1000 }; });
  return { app, pid: child.pid ?? -1, startedAt, exit: () => exit, handlerErrors: () => handlerErrors, warnings: () => warnings };
}

function residentMb(pid: number): number | null {
  try {
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' }).trim());
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}

/** How long a no-op takes to come back from a JS thread: how long that thread
 *  was busy. `capMs` when it did not answer in time (or is gone). */
async function lagMs(run: () => Promise<unknown>, capMs: number): Promise<number> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('cap')); }, capMs); })]);
    return Date.now() - t0;
  } catch {
    return capMs;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface StepStats { peakRssMb: number; maxMainLagMs: number; maxRendererLagMs: number; stalls: number }

/** Samples the main process's resident memory and both JS threads' lag four
 *  times a second, under the name of whatever step is running. */
class Sampler {
  private step = 'boot';
  private readonly stats = new Map<string, StepStats>();
  private running = true;
  private readonly loop: Promise<void>;
  peakRssMb = 0;

  constructor(private readonly observed: Observed, private readonly page: () => Page | null, private readonly samplesPath: string) {
    writeFileSync(samplesPath, 't_s\tstep\trss_mb\tmain_lag_ms\trenderer_lag_ms\n');
    this.loop = this.run();
  }

  enter(step: string): void { this.step = step; }

  of(step: string): StepStats {
    let stats = this.stats.get(step);
    if (stats === undefined) {
      stats = { peakRssMb: 0, maxMainLagMs: 0, maxRendererLagMs: 0, stalls: 0 };
      this.stats.set(step, stats);
    }
    return stats;
  }

  private async run(): Promise<void> {
    while (this.running && this.observed.exit() === null) {
      const step = this.step;
      const rss = residentMb(this.observed.pid);
      const page = this.page();
      const [main, renderer] = await Promise.all([
        lagMs(() => this.observed.app.evaluate(() => 1), 5_000),
        page === null ? Promise.resolve(0) : lagMs(() => page.evaluate(() => 1), 5_000),
      ]);
      const stats = this.of(step);
      if (rss !== null) {
        stats.peakRssMb = Math.max(stats.peakRssMb, rss);
        this.peakRssMb = Math.max(this.peakRssMb, rss);
      }
      stats.maxMainLagMs = Math.max(stats.maxMainLagMs, main);
      stats.maxRendererLagMs = Math.max(stats.maxRendererLagMs, renderer);
      // A second without an answer is a freeze a user feels.
      if (main > 1_000 || renderer > 1_000) stats.stalls += 1;
      appendFileSync(this.samplesPath, `${((Date.now() - this.observed.startedAt) / 1000).toFixed(1)}\t${step}\t${String(rss ?? '?')}\t${String(main)}\t${String(renderer)}\n`);
      await sleep(250);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}

/** What still keeps the current view from being settled. Runs in the renderer
 *  (serialized by page.evaluate — no outer references): the rollup-building
 *  overlay, a visible loader (CoinRainLoader's `<output>`), a "Loading" line,
 *  or a widget slot in view that has not mounted. */
function unsettled(): string[] {
  const blockers: string[] = [];
  if ([...document.querySelectorAll('h3')].some(h => h.textContent === 'Preparing your cost data')) blockers.push('rollup-building overlay');
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
  };
  const loaders = [...document.querySelectorAll('output')].filter(visible).length;
  if (loaders > 0) blockers.push(`${String(loaders)} loader(s)`);
  for (const slot of document.querySelectorAll('[data-widget-id]')) {
    if (slot.getAttribute('data-widget-state') !== 'mounted' && visible(slot)) blockers.push(`${slot.getAttribute('data-widget-id') ?? '(unnamed)'}: not mounted`);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let loading = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (/\bLoading\b/.test(node.textContent ?? '') && node.parentElement !== null && visible(node.parentElement)) loading += 1;
  }
  if (loading > 0) blockers.push(`${String(loading)} "Loading" text(s)`);
  return blockers;
}

/** Wait until the view has shown no blocker for 700 ms. The time that took, or
 *  the blockers still there at `timeoutMs`. */
async function settle(page: Page, timeoutMs: number): Promise<{ ms: number; blockers: string[] }> {
  const t0 = Date.now();
  let cleanSince: number | null = null;
  let last: string[] = ['never evaluated'];
  while (Date.now() - t0 < timeoutMs) {
    last = await page.evaluate(unsettled).catch((err: unknown) => [`page not ready: ${String(err).slice(0, 80)}`]);
    if (last.length === 0) {
      cleanSince ??= Date.now();
      if (Date.now() - cleanSince >= 700) return { ms: cleanSince - t0, blockers: [] };
    } else {
      cleanSince = null;
    }
    await sleep(100);
  }
  return { ms: Date.now() - t0, blockers: last };
}

// ---------------------------------------------------------------------------
// The query log
// ---------------------------------------------------------------------------

interface LogEntry {
  readonly sql: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly rowCount: number | null;
  readonly error: string | null;
  readonly cached: boolean;
  readonly origin: string | null;
}

interface DebugBridge { getQueryLog(): Promise<LogEntry[]>; clearLog(): Promise<void> }

declare global {
  /** The preload's debug bridge, as the page.evaluate callbacks below read it. */
  var costgoblinDebug: DebugBridge;
}

/** A query that reads the provider's raw export rather than rollup partitions.
 *  Told from the SQL: the log's own `materialized` flag is not set by every handler. */
function readsRaw(sql: string): boolean {
  return /[\\/]raw[\\/](daily|hourly)-/.test(sql);
}

interface QuerySummary {
  readonly ran: number;
  readonly cached: number;
  readonly raw: number;
  readonly errors: number;
  readonly unfinished: number;
  readonly slowest: readonly { ms: number | null; raw: boolean; rows: number | null; origin: string | null }[];
}

function summarize(entries: readonly LogEntry[]): QuerySummary {
  const ran = entries.filter(entry => !entry.cached);
  const slowestFirst = [...ran].sort((a, b) => (b.durationMs ?? Number.MAX_SAFE_INTEGER) - (a.durationMs ?? Number.MAX_SAFE_INTEGER));
  return {
    ran: ran.length,
    cached: entries.length - ran.length,
    raw: ran.filter(entry => readsRaw(entry.sql)).length,
    errors: ran.filter(entry => entry.status === 'error' && entry.error !== 'Query cancelled').length,
    unfinished: ran.filter(entry => entry.status === 'queued' || entry.status === 'running').length,
    slowest: slowestFirst.slice(0, 4).map(entry => ({ ms: entry.durationMs, raw: readsRaw(entry.sql), rows: entry.rowCount, origin: entry.origin })),
  };
}

// ---------------------------------------------------------------------------
// The allocator's address space (macOS)
// ---------------------------------------------------------------------------

interface Cage {
  /** Memory the OS charges the process for: what Activity Monitor shows. */
  readonly footprintMb: number | null;
  /** 2 MiB super pages of Chromium's 16 GiB heap reservation handed out so
   *  far. They are never returned: at 8192 the process dies. */
  readonly superPagesUsed: number | null;
  readonly superPagesTotal: 8192;
}

/** DuckDB runs in the main process, where malloc is Chromium's PartitionAlloc:
 *  one 16 GiB reservation (VM tag 253) that only ever fills. `vmmap` shows which
 *  of it is accessible, so how close a session is to the end of it. */
function measureCage(pid: number): Cage | null {
  if (process.platform !== 'darwin') return null;
  let footprintMb: number | null = null;
  try {
    const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf-8', timeout: 60_000 });
    const match = /phys_footprint: (\d+) MB/.exec(out);
    footprintMb = match?.[1] === undefined ? null : Number(match[1]);
  } catch { /* tool missing or the process is gone */ }
  let superPagesUsed: number | null = null;
  try {
    const map = execFileSync('vmmap', [String(pid)], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024, timeout: 180_000 });
    const SUPER_PAGE = 2 * 1024 * 1024;
    const POOL_SHIFT = 34n; // pools are 16 GiB, aligned to their size
    const used = new Map<bigint, { pages: Set<bigint>; bytes: number }>();
    for (const line of map.split('\n')) {
      const match = /^Memory Tag 253\s+([0-9a-f]+)-([0-9a-f]+)\s+\[[^\]]*\]\s+rw/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      const start = BigInt(`0x${match[1]}`);
      const end = BigInt(`0x${match[2]}`);
      const pool = used.get(start >> POOL_SHIFT) ?? { pages: new Set<bigint>(), bytes: 0 };
      for (let page = start / BigInt(SUPER_PAGE); page <= (end - 1n) / BigInt(SUPER_PAGE); page++) pool.pages.add(page);
      pool.bytes += Number(end - start);
      used.set(start >> POOL_SHIFT, pool);
    }
    // The heap pool, not its metadata mirror (one page per super page) nor the small pools.
    const heap = [...used.values()].filter(pool => pool.pages.size >= 16 && pool.bytes / pool.pages.size > 64 * 1024);
    superPagesUsed = heap.length === 0 ? 0 : Math.max(...heap.map(pool => pool.pages.size));
  } catch { /* tool missing, or not allowed to inspect the process */ }
  return { footprintMb, superPagesUsed, superPagesTotal: 8192 };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface StepResult extends StepStats {
  readonly name: string;
  readonly outcome: string;
  readonly settleMs: number;
  readonly blockers: readonly string[];
  readonly handlerErrors: readonly string[];
  readonly queries: QuerySummary;
}

function slug(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

test('walk every view on a clone of a real workspace', async () => {
  test.skip(WORKSPACE === '', 'set COSTGOBLIN_DIAG_WORKSPACE to a workspace directory (…/workspaces/<name>)');
  if (!existsSync(join(WORKSPACE, 'config')) || !existsSync(join(WORKSPACE, 'data'))) {
    throw new Error(`${WORKSPACE} is not a workspace directory (no config/ and data/ in it)`);
  }
  test.setTimeout(PASSES * 45 * 60_000);

  const outDir = join(tmpdir(), 'costgoblin-diag', `large-workspace-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const queryDir = join(outDir, 'queries');
  mkdirSync(queryDir, { recursive: true });
  const cloneRoot = mkdtempSync(join(tmpdir(), 'costgoblin-diag-clone-'));
  let observed: Observed | undefined;
  let sampler: Sampler | undefined;
  try {
    const clone = prepareClone(cloneRoot);
    console.log(`[diag] cloned ${WORKSPACE}\n[diag] report: ${outDir}`);
    const app = await launchOnClone(clone, outDir, 'app');
    observed = app;
    let page: Page | null = null;
    sampler = new Sampler(app, () => page, join(outDir, 'samples.tsv'));
    const monitor = sampler;
    const window = await app.app.firstWindow({ timeout: 180_000 });
    await window.setViewportSize({ width: 1500, height: 950 });
    page = window;

    const results: StepResult[] = [];
    const cages: { after: string; cage: Cage }[] = [];
    const report = (): void => {
      writeFileSync(join(outDir, 'report.json'), JSON.stringify({
        workspace: basename(WORKSPACE), passes: PASSES, memoryLimitGB: MEMORY_GB ?? 'app default',
        exit: app.exit(), peakRssMb: monitor.peakRssMb, rollup: rollupProgress(clone.providerDir), cages,
        warnings: [...new Set(app.warnings())].slice(0, 60), steps: results,
      }, null, 2));
    };

    const step = async (name: string, action: (p: Page) => Promise<void>): Promise<void> => {
      if (app.exit() !== null) return;
      monitor.enter(name);
      const errorsBefore = app.handlerErrors().length;
      if (results.length > 0) await window.evaluate(() => globalThis.costgoblinDebug.clearLog()).catch(() => undefined);
      let outcome = 'ok';
      try {
        await Promise.race([action(window), sleep(60_000).then(() => { throw new Error('the action took over 60s'); })]);
      } catch (err) {
        outcome = `action failed: ${String(err instanceof Error ? err.message : err).split('\n')[0]?.slice(0, 160) ?? ''}`;
      }
      const settled = await settle(window, SETTLE_MS);
      if (settled.blockers.length > 0 && outcome === 'ok') outcome = 'did not settle';
      const entries = await window.evaluate(() => globalThis.costgoblinDebug.getQueryLog()).catch((): LogEntry[] => []);
      writeFileSync(join(queryDir, `${String(results.length + 1).padStart(2, '0')}-${slug(name)}.json`), JSON.stringify(entries, null, 1));
      const stats = monitor.of(name);
      const queries = summarize(entries);
      results.push({
        name, outcome, settleMs: settled.ms, blockers: settled.blockers, ...stats,
        handlerErrors: [...new Set(app.handlerErrors().slice(errorsBefore))].slice(0, 5), queries,
      });
      console.log(`[diag] ${name.padEnd(40)} ${outcome.padEnd(15)} ${(settled.ms / 1000).toFixed(1).padStart(6)} s | ${String(queries.ran).padStart(2)} queries, ${String(queries.raw)} raw, slowest ${queries.slowest[0]?.ms === undefined || queries.slowest[0].ms === null ? '-' : (queries.slowest[0].ms / 1000).toFixed(1)} s | rss ${(stats.peakRssMb / 1024).toFixed(1)} GB | lag ${String(stats.maxMainLagMs)}/${String(stats.maxRendererLagMs)} ms${stats.stalls > 0 ? ` | ${String(stats.stalls)} stall(s)` : ''}`);
      report();
    };

    // The first paint: with no valid rollup this is the whole pre-aggregation.
    await step('boot', async () => { /* nothing to click */ });
    const dashboards = dashboardNames(clone.workspaceDir);
    for (let pass = 1; pass <= PASSES; pass++) {
      const tag = PASSES > 1 ? `p${String(pass)} ` : '';
      const presets = PRESETS[(pass - 1) % PRESETS.length] ?? [];
      // A later pass sets its first range on the first dashboard: the range
      // carries over to the other dashboards and to Home, which then load at it.
      const carried = pass > 1 ? presets[0] : undefined;
      for (const [index, name] of dashboards.entries()) {
        await step(`${tag}dashboard: ${name}`, async (p) => { await clickNavButton(p, name); });
        if (carried !== undefined && index === 0) await step(`${tag}dashboard: ${name} @ ${carried}`, async (p) => { await pickDatePreset(p, carried); });
      }
      await step(`${tag}home`, async (p) => { await clickNavButton(p, 'Home'); });
      for (const preset of presets) {
        if (preset === carried) continue;
        await step(`${tag}home @ ${preset}`, async (p) => { await pickDatePreset(p, preset); });
      }
      for (const view of ['Trends', 'Tags', 'Findings', 'Explorer', 'Cost Scope', 'Dimensions', 'Sync', 'Performance', 'Home']) {
        await step(`${tag}${view.toLowerCase()}`, async (p) => { await clickNavButton(p, view); });
      }
      if (app.exit() === null) {
        const cage = measureCage(app.pid);
        if (cage !== null) {
          cages.push({ after: `pass ${String(pass)}`, cage });
          const pages = cage.superPagesUsed;
          console.log(`[diag] after pass ${String(pass)}: footprint ${String(cage.footprintMb ?? '?')} MB, allocator address space ${pages === null ? '?' : `${String(Math.round(100 * pages / cage.superPagesTotal))}% handed out (${String(pages)}/${String(cage.superPagesTotal)} super pages)`}`);
        }
      }
    }
    await monitor.stop();
    report();

    const exit = app.exit();
    const slow = results.filter(r => r.settleMs > 10_000 || r.outcome !== 'ok');
    console.log(`[diag] ${exit === null ? 'the app survived' : `THE APP DIED: ${exit.signal ?? String(exit.code)} at ${exit.atS.toFixed(0)} s`} | peak ${(monitor.peakRssMb / 1024).toFixed(1)} GB resident | ${String(slow.length)} step(s) over 10 s or unfinished`);
    for (const r of slow) console.log(`[diag]   ${r.name}: ${r.outcome}, ${(r.settleMs / 1000).toFixed(0)} s${r.blockers.length > 0 ? ` (${r.blockers.join('; ').slice(0, 100)})` : ''}`);
    // A month missing from the rollup sends every query over it to the raw export.
    const rollup = rollupProgress(clone.providerDir);
    if (rollup !== null) console.log(`[diag] rollup: ${String(rollup.built)} of ${String(rollup.months)} months built${rollup.built < rollup.months ? ' — INCOMPLETE' : ''}`);
    const warned = [...new Set(app.warnings())];
    if (warned.length > 0) console.log(`[diag] ${String(warned.length)} distinct warning(s) in the app's log:\n${warned.slice(0, 12).map(line => `[diag]   ${line.slice(0, 200)}`).join('\n')}`);

    if (exit !== null && TELEMETRY) {
      // Crashpad hands a native crash to the SDK on the next launch: give it one,
      // with a limit low enough not to die the same way before the upload.
      await closeAndForget(app.app);
      observed = undefined;
      writePreferences(clone.workspaceDir, '2');
      const again = await launchOnClone(clone, outDir, 'upload');
      observed = again;
      await sleep(45_000);
      console.log('[diag] relaunched for 45 s so the crash report could be uploaded');
    }
    expect(exit, 'the app process ended during the walk').toBeNull();
  } finally {
    await sampler?.stop();
    if (observed !== undefined) await closeApp(observed.app);
    rmSync(cloneRoot, { recursive: true, force: true });
  }
});

/** closeApp for an app that already exited: only its bookkeeping is left. */
async function closeAndForget(app: ElectronApplication): Promise<void> {
  await closeApp(app).catch(() => undefined);
}
