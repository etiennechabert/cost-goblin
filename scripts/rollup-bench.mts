/**
 * Rollup benchmark — confirm the performance gain (raw vs rollup) and the rollup
 * build cost, against a real FOCUS 1.2 dataset, using the real query builders + config.
 *
 * Reproducible:
 *   COSTGOBLIN_DATA_DIR=/path/to/data/processed \
 *   COSTGOBLIN_CONFIG_DIR=/path/to/data/config \
 *   npx tsx scripts/rollup-bench.mts
 *
 * Builds per-period rollup partitions to an OS temp dir (your data dir is never
 * written to), measures build time + on-disk size, then times representative
 * dashboard queries (cost-by-service, daily-costs-by-service) over RAW parquet
 * vs the rollup partition glob for a 30-day and a 365-day window. Also asserts
 * rollup total == raw total (correctness gate). Throwaway temp dir is removed.
 *
 * Lives under scripts/ (outside the lint/tsc globs) intentionally — it's a dev
 * tool, not shipped code.
 */
import { cpus, totalmem } from 'node:os';
import { readFile, mkdir, mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildSource, buildRollupPartitionQuery, buildCostQuery, buildDailyCostsQuery, computePeriodsInRange, buildRuleMatchExpr } from '../packages/core/src/query/builder.js';
import { loadConfig, loadDimensions, loadCostScope } from '../packages/core/src/config/loader.js';
import { asProviderName } from '../packages/core/src/types/branded.js';
import { listLocalMonths } from '../packages/core/src/sync/sync-utils.js';

const DATA = process.env['COSTGOBLIN_DATA_DIR'] ?? 'C:/Users/etien/Desktop/cost-goblin/data/processed';
const CONFIG = process.env['COSTGOBLIN_CONFIG_DIR'] ?? `${DATA}/../config`;
const ORG_DIR = `${DATA}/..`; // org-accounts.json / org-account-tags.json live beside data/processed

const iso = (d: Date) => d.toISOString().slice(0, 10);
const ms = (n: number) => `${n.toFixed(0)} ms`;
const s = (n: number) => `${(n / 1000).toFixed(2)} s`;
const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`;
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; };

const duck = (await import('@duckdb/node-api')) as unknown as { DuckDBInstance: { create: () => Promise<any> } };
const conn = await (await duck.DuckDBInstance.create()).connect();
await conn.run(`SET threads=${cpus().length}`);

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const r = await conn.run(sql); const n = r.columnCount; const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(r.columnName(i));
  const out: Record<string, unknown>[] = []; let ch = await r.fetchChunk();
  while (ch !== null && ch.rowCount > 0) { for (let i = 0; i < ch.rowCount; i++) { const o: Record<string, unknown> = {}; for (let j = 0; j < n; j++) o[names[j]!] = ch.getColumnVector(j).getItem(i); out.push(o); } ch = await r.fetchChunk(); }
  return out;
}
function bind(stmt: any, params: readonly unknown[]) { for (let i = 0; i < params.length; i++) { const v = params[i], idx = i + 1; if (v == null) stmt.bindNull(idx); else if (typeof v === 'string') stmt.bindVarchar(idx, v); else if (typeof v === 'number') Number.isInteger(v) ? stmt.bindInteger(idx, v) : stmt.bindDouble(idx, v); else if (typeof v === 'boolean') stmt.bindBoolean(idx, v); else stmt.bindVarchar(idx, JSON.stringify(v)); } }
async function timeQuery(sql: string, params: readonly unknown[], runsN: number): Promise<number> {
  const drain = async (stmt: any) => { const r = await stmt.run(); let ch = await r.fetchChunk(); while (ch !== null && ch.rowCount > 0) ch = await r.fetchChunk(); };
  const stmt = await conn.prepare(sql); bind(stmt, params);
  await drain(stmt); // warmup
  const t: number[] = [];
  for (let i = 0; i < runsN; i++) { const a = performance.now(); await drain(stmt); t.push(performance.now() - a); }
  stmt.destroySync();
  return median(t);
}

// ---- setup ----
const dims = await loadDimensions(`${CONFIG}/dimensions.yaml`);
// Provider dir under DATA (#516 layout: {dataDir}/{providerName}/raw). Falls
// back to the legacy 'aws' dir when the config can't be read.
const PROVIDER = await loadConfig(`${CONFIG}/costgoblin.yaml`).then(c => c.providers[0]?.name ?? asProviderName('aws')).catch(() => asProviderName('aws'));
const cs = await loadCostScope(`${CONFIG}/cost-scope.yaml`);
const acct = JSON.parse(await readFile(`${ORG_DIR}/org-accounts.json`, 'utf-8')) as { accounts: { id?: string; name?: string }[] };
const arm = new Map<string, string[]>();
for (const a of acct.accounts) if (typeof a.id === 'string' && typeof a.name === 'string') { const ids = arm.get(a.name) ?? []; ids.push(a.id); arm.set(a.name, ids); }
const allMonths = await listLocalMonths(DATA, PROVIDER, 'daily');
const months = allMonths.slice(-12);
const latest = allMonths[allMonths.length - 1]!;
const orgTags = `${ORG_DIR}/org-account-tags.json`;
const lag = cs.lagDays ?? 2;
const end = new Date(Date.now() - lag * 86_400_000);

console.log(`\n=== Rollup benchmark ===`);
console.log(`threads=${cpus().length} RAM=${(totalmem() / 1e9).toFixed(0)}GB | metric=${cs.costMetric} enabledRules=${cs.rules.filter(r => r.enabled).length}`);
console.log(`daily months on disk: ${allMonths.length}; benchmarking last ${months.length} (${months[0]}..${latest})`);

// ---- (1) BUILD ----
const rollupDir = await mkdtemp(join(tmpdir(), 'cg-rollup-bench-'));
const optsBuild = { dataDir: DATA, dimensions: dims, orgAccountsPath: orgTags, accountReverseMap: arm, costScope: cs, providers: [{ name: PROVIDER }] };
console.log(`\n--- (1) build per-period partitions (cold) ---`);
const buildTimes: number[] = []; let rollupBytes = 0; let rollupRows = 0;
for (const m of months) {
  const dir = join(rollupDir, `daily-${m}`); await mkdir(dir, { recursive: true });
  const out = join(dir, 'rollup.parquet');
  const t = performance.now(); await conn.run(buildRollupPartitionQuery(m, 'daily', out, optsBuild)); buildTimes.push(performance.now() - t);
  rollupBytes += (await stat(out)).size;
  rollupRows += Number((await rows(`SELECT COUNT(*)::BIGINT n FROM read_parquet('${out.replaceAll('\\', '/')}')`))[0]!['n']);
}
const totalBuild = buildTimes.reduce((a, b) => a + b, 0);
console.log(`  per-month: median ${ms(median(buildTimes))}, max ${ms(Math.max(...buildTimes))}`);
console.log(`  full ${months.length}-month build (sequential): ${s(totalBuild)}`);
console.log(`  rollup rows: ${rollupRows.toLocaleString()}, size: ${mb(rollupBytes)}`);

// raw size for the same months
let rawBytes = 0;
for (const m of months) { const d = `${DATA}/${PROVIDER}/raw/daily-${m}`; for (const f of await readdir(d)) if (f.endsWith('.parquet')) rawBytes += (await stat(`${d}/${f}`)).size; }
console.log(`  raw parquet (same ${months.length} months): ${(rawBytes / 1e9).toFixed(1)} GB → rollup is ${(rollupBytes / rawBytes * 100).toFixed(1)}% of raw`);

const glob = `read_parquet('${join(rollupDir, 'daily-*', 'rollup.parquet').replaceAll('\\', '/')}')`;

// ---- (2) CORRECTNESS gate ----
const fullStart = `${months[0]}-01`;
const rawSrcFull = buildSource({ dataDir: DATA, tier: 'daily', dimensions: dims, orgAccountsPath: orgTags, providers: [{ name: PROVIDER, periods: months }], costMetric: cs.costMetric ?? 'effective', includeRawTags: false, slim: true });
const excl = cs.rules.filter(r => r.enabled).map(r => buildRuleMatchExpr(r, dims, arm)).filter((e): e is string => e !== null).map(e => `NOT (${e})`);
const fullW = `usage_date >= '${fullStart}' AND usage_date <= '${iso(end)}'`;
const rawTotal = Number((await rows(`SELECT SUM(cost) t FROM ${rawSrcFull} WHERE ${fullW}${excl.length ? ' AND ' + excl.join(' AND ') : ''}`))[0]!['t']);
const rollTotal = Number((await rows(`SELECT SUM(cost) t FROM ${glob} WHERE ${fullW}`))[0]!['t']);
console.log(`\n--- (2) correctness: rollup total vs raw total (full window) ---`);
console.log(`  raw ${rawTotal.toFixed(2)} | rollup ${rollTotal.toFixed(2)} | diff ${((rollTotal - rawTotal) / rawTotal * 100).toFixed(4)}%`);

// ---- (3) QUERY LATENCY: raw vs rollup ----
console.log(`\n--- (3) dashboard query latency: RAW parquet vs rollup glob ---`);
const windows: { label: string; days: number }[] = [{ label: '30-day', days: 30 }, { label: '365-day', days: 365 }];
const acctId = acct.accounts.find(a => typeof a.id === 'string')?.id ?? '';
for (const w of windows) {
  const start = iso(new Date(end.getTime() - (w.days - 1) * 86_400_000));
  const dr = { start, end: iso(end) };
  const periods = computePeriodsInRange(dr).filter(p => allMonths.includes(p));
  const rawOpts = { dataDir: DATA, dimensions: dims, orgAccountsPath: orgTags, accountReverseMap: arm, costScope: cs, providers: [{ name: PROVIDER, availablePeriods: periods }] };
  const matOpts = { ...rawOpts, materializedSource: glob };
  const queries: { name: string; raw: { sql: string; params: readonly unknown[] }; mat: { sql: string; params: readonly unknown[] } }[] = [
    { name: 'cost by service', raw: buildCostQuery({ groupBy: 'service', dateRange: dr, filters: {}, granularity: 'daily' } as any, rawOpts), mat: buildCostQuery({ groupBy: 'service', dateRange: dr, filters: {}, granularity: 'daily' } as any, matOpts) },
    { name: 'daily by service', raw: buildDailyCostsQuery({ groupBy: 'service', dateRange: dr, filters: {}, granularity: 'daily' } as any, rawOpts), mat: buildDailyCostsQuery({ groupBy: 'service', dateRange: dr, filters: {}, granularity: 'daily' } as any, matOpts) },
  ];
  console.log(`  ${w.label} window (${dr.start}..${dr.end}, ${periods.length} months):`);
  for (const q of queries) {
    const rawMs = await timeQuery(q.raw.sql, q.raw.params, 3);
    const matMs = await timeQuery(q.mat.sql, q.mat.params, 5);
    console.log(`    ${q.name.padEnd(18)} raw ${s(rawMs).padStart(8)}  rollup ${ms(matMs).padStart(8)}  → ${(rawMs / matMs).toFixed(0)}× faster`);
  }
}

await rm(rollupDir, { recursive: true, force: true });
void acctId;
console.log(`\n=== done (temp rollup removed) ===\n`);
process.exit(0);
