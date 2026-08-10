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
import { resolveFormat, toolResult } from './tool-helpers.js';

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
function parseBandConfig(specsRaw: unknown): { lowerPct: number; upperPct: number; windowDays: number } {
  let lowerPct = envNum('COSTGOBLIN_BASELINES_LOWER_PCT', 10);
  let upperPct = envNum('COSTGOBLIN_BASELINES_UPPER_PCT', 90);
  let windowDays = envNum('COSTGOBLIN_BASELINES_WINDOW_DAYS', 30);
  if (isRecord(specsRaw) && isRecord(specsRaw['config'])) {
    const c = specsRaw['config'];
    if (typeof c['lowerPct'] === 'number') lowerPct = c['lowerPct'];
    if (typeof c['upperPct'] === 'number') upperPct = c['upperPct'];
    if (typeof c['windowDays'] === 'number') windowDays = c['windowDays'];
  }
  return { lowerPct, upperPct, windowDays };
}

function parseSpecs(specsRaw: unknown): Spec[] {
  const specs: Spec[] = [];
  if (!isRecord(specsRaw) || !Array.isArray(specsRaw['baselines'])) return specs;
  for (const s of specsRaw['baselines']) {
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

function parseHistory(dataRaw: unknown): Map<string, readonly BaselineDailyPoint[]> {
  const history = new Map<string, readonly BaselineDailyPoint[]>();
  if (!isRecord(dataRaw) || !isRecord(dataRaw['history'])) return history;
  for (const [id, pts] of Object.entries(dataRaw['history'])) {
    if (!Array.isArray(pts)) continue;
    history.set(id, pts.filter(isRecord).map((p) => ({ date: asDateString(str(p['date'])), cost: asDollars(num(p['cost'])) })));
  }
  return history;
}

function parseSnapshots(dataRaw: unknown): Map<string, readonly Record<string, unknown>[]> {
  const snapshots = new Map<string, readonly Record<string, unknown>[]>();
  if (!isRecord(dataRaw) || !isRecord(dataRaw['snapshots'])) return snapshots;
  for (const [id, snaps] of Object.entries(dataRaw['snapshots'])) {
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

  return {
    specs: parseSpecs(specsRaw),
    history: parseHistory(dataRaw),
    snapshots: parseSnapshots(dataRaw),
    ...parseBandConfig(specsRaw),
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

function fmt(n: number): string { return `$${n.toFixed(2)}`; }

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

  if (format === 'json') {
    return toolResult(JSON.stringify(rows.map((r) => ({
      id: r.id, name: r.name ?? r.scopeLabel, scope: r.scopeLabel, source: r.source, status: r.status,
      currentPerDay: r.current, bandLowerPerDay: r.lower, bandUpperPerDay: r.upper,
      potentialPerMonth: r.potentialMonthly, realizedPerMonth: r.realizedMonthly, dataPoints: r.dataPoints,
    })), null, 2));
  }

  const header = '| Scope | Status | Current/day | Band/day | Potential/mo | Realized/mo |\n|---|---|---:|---:|---:|---:|';
  const lines = rows.map((r) => `| ${r.name ?? r.scopeLabel} | ${r.status} | ${fmt(r.current)} | ${fmt(r.lower)}–${fmt(r.upper)} | ${fmt(r.potentialMonthly)} | ${fmt(r.realizedMonthly)} |`);
  const totalPot = rows.reduce((s, r) => s + r.potentialMonthly, 0);
  return toolResult(`# Cost baselines (${String(rows.length)})\n\nTotal potential savings shown: ${fmt(totalPot)}/mo\n\n${header}\n${lines.join('\n')}`);
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
  if (format === 'json') {
    return toolResult(JSON.stringify({
      scope: r.scopeLabel, status: r.status, currentPerDay: r.current, bandLowerPerDay: r.lower, bandUpperPerDay: r.upper,
      potentialPerMonth: r.potentialMonthly, realizedPerMonth: r.realizedMonthly,
      trend: snaps.map((s) => ({ date: str(s['date']), current: num(s['current']), status: str(s['status']) })),
    }, null, 2));
  }
  const trend = snaps.map((s) => `| ${str(s['date'])} | ${fmt(num(s['current']))} | ${str(s['status'])} |`).join('\n');
  return toolResult(
    `# Baseline drift — ${r.name ?? r.scopeLabel}\n\n` +
    `Status: **${r.status}** · current ${fmt(r.current)}/day · band ${fmt(r.lower)}–${fmt(r.upper)}/day\n` +
    `Potential ${fmt(r.potentialMonthly)}/mo · realized ${fmt(r.realizedMonthly)}/mo\n\n` +
    (trend.length > 0 ? `Recent snapshots:\n\n| Date | Current/day | Status |\n|---|---:|---|\n${trend}` : '_No snapshot history yet._'),
  );
}
