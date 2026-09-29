import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asDateString,
  asDollars,
  computeBands,
  computeCurrent,
  computeSavings,
  deriveStatus,
  effectiveBands,
  runRateSeries,
} from '@costgoblin/core';
import type { BaselineDailyPoint, BaselineStatus, ManualBand } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, MetaField, StructuredResult } from '../formatters/result.js';
import { resolveFormat, structuredToolResult, toolResult } from './tool-helpers.js';

interface Spec {
  readonly id: string;
  readonly name: string | undefined;
  readonly source: string;
  readonly scopeLabel: string;
  readonly manualBand: ManualBand | undefined;
}

interface Derived extends Spec {
  readonly current: number;
  readonly lower: number;
  readonly upper: number;
  readonly potentialMonthly: number;
  readonly realizedMonthly: number;
  readonly status: BaselineStatus;
  readonly dataPoints: number;
}

interface Loaded {
  readonly specs: readonly Spec[];
  readonly history: ReadonlyMap<string, readonly BaselineDailyPoint[]>;
  readonly snapshots: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  readonly lowerPct: number;
  readonly upperPct: number;
  readonly windowDays: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function str(v: unknown): string { return typeof v === 'string' ? v : ''; }
function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function scopeLabel(scope: unknown): string {
  if (!isRecord(scope)) return 'All';
  if (scope['kind'] === 'view') return `View: ${str(scope['viewId'])}`;
  if (!isRecord(scope['filters'])) return 'All';
  const parts: string[] = [];
  for (const [dim, vals] of Object.entries(scope['filters'])) {
    if (Array.isArray(vals)) parts.push(`${dim}=${vals.map(String).join(',')}`);
  }
  return parts.join(' · ') || 'All';
}

function parseManualBand(v: unknown): ManualBand | undefined {
  if (!isRecord(v)) return undefined;
  const mode = v['mode'];
  if (mode !== 'absolute' && mode !== 'percentile') return undefined;
  return {
    mode,
    ...(typeof v['lower'] === 'number' ? { lower: v['lower'] } : {}),
    ...(typeof v['upper'] === 'number' ? { upper: v['upper'] } : {}),
  };
}

/** Band config: persisted user override wins, else the same env-configurable
 *  defaults the desktop store uses, so the run-rate band matches. */
function parseBandConfig(config: unknown): { lowerPct: number; upperPct: number; windowDays: number } {
  let lowerPct = envNum('COSTGOBLIN_BASELINES_LOWER_PCT', 10);
  let upperPct = envNum('COSTGOBLIN_BASELINES_UPPER_PCT', 90);
  let windowDays = envNum('COSTGOBLIN_BASELINES_WINDOW_DAYS', 30);
  if (isRecord(config)) {
    if (typeof config['lowerPct'] === 'number') lowerPct = config['lowerPct'];
    if (typeof config['upperPct'] === 'number') upperPct = config['upperPct'];
    if (typeof config['windowDays'] === 'number') windowDays = config['windowDays'];
  }
  return { lowerPct, upperPct, windowDays };
}

function parseSpecs(baselines: unknown): Spec[] {
  const specs: Spec[] = [];
  if (!Array.isArray(baselines)) return specs;
  for (const s of baselines) {
    if (!isRecord(s)) continue;
    specs.push({
      id: str(s['id']),
      name: typeof s['name'] === 'string' ? s['name'] : undefined,
      source: str(s['source']) || 'discovered',
      scopeLabel: scopeLabel(s['scope']),
      manualBand: parseManualBand(s['manualBand']),
    });
  }
  return specs;
}

function parseHistory(historyRaw: unknown): Map<string, readonly BaselineDailyPoint[]> {
  const history = new Map<string, readonly BaselineDailyPoint[]>();
  if (!isRecord(historyRaw)) return history;
  for (const [id, pts] of Object.entries(historyRaw)) {
    if (!Array.isArray(pts)) continue;
    history.set(id, pts.filter(isRecord).map((p) => ({ date: asDateString(str(p['date'])), cost: asDollars(num(p['cost'])) })));
  }
  return history;
}

function parseSnapshots(snapshotsRaw: unknown): Map<string, readonly Record<string, unknown>[]> {
  const snapshots = new Map<string, readonly Record<string, unknown>[]>();
  if (!isRecord(snapshotsRaw)) return snapshots;
  for (const [id, snaps] of Object.entries(snapshotsRaw)) {
    if (Array.isArray(snaps)) snapshots.set(id, snaps.filter(isRecord));
  }
  return snapshots;
}

async function load(ctx: McpContext): Promise<Loaded> {
  const base = ctx.stateDir;
  let specsRaw: unknown;
  let dataRaw: unknown;
  try { specsRaw = JSON.parse(await readFile(join(base, 'baselines.json'), 'utf-8')); } catch { specsRaw = {}; }
  try { dataRaw = JSON.parse(await readFile(join(base, 'baselines-data.json'), 'utf-8')); } catch { dataRaw = {}; }

  // The two state files' top-level layout is narrowed HERE, once — the parsers
  // below receive only the slice they own.
  const specsRoot = isRecord(specsRaw) ? specsRaw : {};
  const dataRoot = isRecord(dataRaw) ? dataRaw : {};
  return {
    specs: parseSpecs(specsRoot['baselines']),
    history: parseHistory(dataRoot['history']),
    snapshots: parseSnapshots(dataRoot['snapshots']),
    ...parseBandConfig(specsRoot['config']),
  };
}

function derive(spec: Spec, loaded: Loaded): Derived {
  const history = loaded.history.get(spec.id) ?? [];
  // Band the effective-cost run-rate (matches the desktop store) so a periodic/spiky
  // charge can't set a phantom ceiling that inflates realized savings.
  const runRate = runRateSeries(history, loaded.windowDays);
  const bands = computeBands(runRate, { lowerPct: loaded.lowerPct, upperPct: loaded.upperPct });
  const current = computeCurrent(history, loaded.windowDays);
  const eff = effectiveBands(bands, spec.manualBand, runRate.map((p) => p.cost));
  const savings = computeSavings(current, eff);
  const status = deriveStatus(current, eff, history.length, { minDataPoints: 30, subCentFloor: 0.01, overPctOverLower: 0 });
  return {
    ...spec,
    current: current?.avgDaily ?? 0,
    lower: eff.lower,
    upper: eff.upper,
    potentialMonthly: savings.potentialMonthly,
    realizedMonthly: savings.realizedMonthly,
    status,
    dataPoints: history.length,
  };
}

/** Column keys reuse the field names of the JSON these tools returned before
 *  they moved onto StructuredResult, so a json consumer finds the same names. */
const LIST_COLUMNS: readonly Column[] = [
  { key: 'id', header: 'ID' },
  { key: 'name', header: 'Name' },
  { key: 'scope', header: 'Scope' },
  { key: 'source', header: 'Source' },
  { key: 'status', header: 'Status' },
  { key: 'currentPerDay', header: 'Current/day', type: 'currency' },
  { key: 'bandLowerPerDay', header: 'Band low/day', type: 'currency' },
  { key: 'bandUpperPerDay', header: 'Band high/day', type: 'currency' },
  { key: 'potentialPerMonth', header: 'Potential/mo', type: 'currency' },
  { key: 'realizedPerMonth', header: 'Realized/mo', type: 'currency' },
  { key: 'dataPoints', header: 'Data points', type: 'number' },
];

function listRow(r: Derived): Cell[] {
  return [
    r.id, r.name ?? r.scopeLabel, r.scopeLabel, r.source, r.status,
    r.current, r.lower, r.upper, r.potentialMonthly, r.realizedMonthly, r.dataPoints,
  ];
}

const SNAPSHOT_COLUMNS: readonly Column[] = [
  { key: 'date', header: 'Date' },
  { key: 'current', header: 'Current/day', type: 'currency' },
  { key: 'status', header: 'Status' },
];

export async function listBaselines(
  ctx: McpContext,
  params: { status?: string | undefined; limit?: number | undefined; format?: string | undefined },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const loaded = await load(ctx);
  let rows = loaded.specs.map((s) => derive(s, loaded));
  if (params.status === 'actionable') rows = rows.filter((r) => r.status === 'over' || r.status === 'under');
  else if (params.status !== undefined) rows = rows.filter((r) => r.status === params.status);
  rows.sort((a, b) => b.potentialMonthly - a.potentialMonthly);
  const limit = params.limit ?? 25;
  rows = rows.slice(0, limit);

  const format = resolveFormat(params.format);
  if (rows.length === 0) return toolResult('No baselines found. They are discovered after a sync; ask the user to open the Baselines page and Recompute.');

  const totalPot = rows.reduce((s, r) => s + r.potentialMonthly, 0);
  const result: StructuredResult = {
    title: `Cost baselines (${String(rows.length)})`,
    meta: [{ label: 'Total potential', value: totalPot, type: 'currency' }],
    tables: [{ columns: LIST_COLUMNS, rows: rows.map(listRow) }],
  };
  return structuredToolResult(result, format);
}

export async function getBaselineDrift(
  ctx: McpContext,
  params: { id?: string | undefined; match?: string | undefined; format?: string | undefined },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const loaded = await load(ctx);
  const matchLower = (params.match ?? '').trim().toLowerCase();
  // Guard the empty-match wildcard: ''.includes('') is true, so without this an
  // argument-less call would return drift for an arbitrary (first) baseline.
  if (params.id === undefined && matchLower === '') {
    return toolResult('Specify either `id` or a non-empty `match` to identify a baseline. Use list_baselines to see available scopes.');
  }
  const spec = params.id !== undefined
    ? loaded.specs.find((s) => s.id === params.id)
    : loaded.specs.find((s) => (s.name ?? s.scopeLabel).toLowerCase().includes(matchLower) || s.scopeLabel.toLowerCase().includes(matchLower));
  if (spec === undefined) return toolResult('No matching baseline. Use list_baselines to see available scopes.');

  const r = derive(spec, loaded);
  const snaps = (loaded.snapshots.get(spec.id) ?? []).slice(-10);
  const format = resolveFormat(params.format);
  const meta: MetaField[] = [
    { label: 'Scope', value: r.scopeLabel },
    { label: 'Status', value: r.status },
    { label: 'Current/day', value: r.current, type: 'currency' },
    { label: 'Band low/day', value: r.lower, type: 'currency' },
    { label: 'Band high/day', value: r.upper, type: 'currency' },
    { label: 'Potential/mo', value: r.potentialMonthly, type: 'currency' },
    { label: 'Realized/mo', value: r.realizedMonthly, type: 'currency' },
  ];
  const result: StructuredResult = {
    title: `Baseline drift — ${r.name ?? r.scopeLabel}`,
    meta,
    ...(snaps.length > 0
      ? {
        tables: [{
          title: 'Recent snapshots',
          columns: SNAPSHOT_COLUMNS,
          rows: snaps.map((snap): Cell[] => [str(snap['date']), num(snap['current']), str(snap['status'])]),
        }],
      }
      : { notes: ['_No snapshot history yet._'] }),
  };
  return structuredToolResult(result, format);
}
