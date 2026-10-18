import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpContext } from '../context.js';
import { getBaselineDrift, listBaselines } from '../tools/baselines.js';
import { parseJsonResult, resultText } from './helpers/json-result.js';

// list_baselines / get_baseline_drift read only the two baselines state JSONs
// under ctx.stateDir. Every scenario writes its own state dir, so the parsing
// of a hand-edited, partial or corrupt file is exercised as well as the band,
// status and savings maths the tools derive from the stored history.

/** `count` consecutive days from 2026-01-01, each costing `cost(i)`. */
function days(count: number, cost: (i: number) => number): { date: string; cost: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    cost: cost(i),
  }));
}

const notUsed = (): never => { throw new Error('not used by the baselines tools'); };

function ctxFor(stateDir: string): McpContext {
  return {
    dataDir: stateDir,
    stateDir,
    runQuery: notUsed,
    runPreparedQuery: notUsed,
    getConfig: notUsed,
    getDimensions: notUsed,
    getQueryDimensions: notUsed,
    getCostScope: notUsed,
    getAccountMap: notUsed,
    getAccountReverseMap: notUsed,
    getOrgAccountsPath: notUsed,
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
    now: () => Date.UTC(2026, 2, 1),
  };
}

let root: string;
let counter = 0;

/** A fresh state dir holding the given raw file contents (a missing key means
 *  the file is not written at all). */
async function stateWith(files: { specs?: string; data?: string }): Promise<McpContext> {
  counter += 1;
  const dir = join(root, `state-${String(counter)}`);
  await mkdir(dir, { recursive: true });
  if (files.specs !== undefined) await writeFile(join(dir, 'baselines.json'), files.specs);
  if (files.data !== undefined) await writeFile(join(dir, 'baselines-data.json'), files.data);
  return ctxFor(dir);
}

const NO_BASELINES = 'No baselines found. They are discovered after a sync; ask the user to open the Baselines page and Recompute.';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cg-mcp-baselines-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('list_baselines', () => {
  // Five baselines over the same flat $100/day history (40 days unless noted):
  // the manual bands put one above and one below its band, the automated band
  // of a flat series is [100, 100], and short/absent histories are thin.
  const flat = days(40, () => 100);
  const SPECS = JSON.stringify({
    baselines: [
      {
        id: 'b-none',
        name: 'Never synced',
        source: 'manual',
        scope: { filters: { service: ['S3'] } },
      },
      {
        id: 'b-under',
        source: 'manual',
        scope: { kind: 'view', viewId: 'v1' },
        manualBand: { mode: 'absolute', lower: 150, upper: 200 },
      },
      {
        id: 'b-over',
        name: 'Compute',
        source: 'discovered',
        // The non-array region entry is not a filter: it is left out of the label.
        scope: { filters: { service: ['EC2', 'EBS'], region: 'eu-west-1' } },
        manualBand: { mode: 'absolute', lower: 50, upper: 80 },
      },
      {
        id: 'b-flat',
        source: '',
        scope: { filters: {} },
        // An unknown mode is no override: the automated band applies.
        manualBand: { mode: 'sideways', lower: 1, upper: 2 },
      },
      { id: 'b-thin', name: 'Thin', scope: 'not-a-scope-object' },
      'not-a-baseline',
      null,
    ],
  });
  const DATA = JSON.stringify({
    history: { 'b-under': flat, 'b-over': flat, 'b-flat': flat, 'b-thin': days(5, () => 100) },
  });

  let ctx: McpContext;
  beforeAll(async () => {
    ctx = await stateWith({ specs: SPECS, data: DATA });
  });

  it('derives status, band and savings per baseline and ranks by potential savings', async () => {
    const out = parseJsonResult(resultText(await listBaselines(ctx, { format: 'json' })));
    expect(out.title).toBe('Cost baselines (5)');
    // Only b-over has potential (100/day current over a $50 floor, x30 days).
    expect(out.meta.get('Total potential')).toBe(1500);
    const rows = out.tables[0]?.rows ?? [];
    expect(rows.map(r => r['id'])).toEqual(['b-over', 'b-none', 'b-under', 'b-flat', 'b-thin']);
    expect(rows[0]).toEqual({
      id: 'b-over', name: 'Compute', scope: 'service=EC2,EBS', source: 'discovered', status: 'over',
      currentPerDay: 100, bandLowerPerDay: 50, bandUpperPerDay: 80,
      potentialPerMonth: 1500, realizedPerMonth: 0, dataPoints: 40,
    });
    // No history at all: no current, no band, nothing to save.
    expect(rows[1]).toEqual({
      id: 'b-none', name: 'Never synced', scope: 'service=S3', source: 'manual', status: 'insufficient-data',
      currentPerDay: 0, bandLowerPerDay: 0, bandUpperPerDay: 0,
      potentialPerMonth: 0, realizedPerMonth: 0, dataPoints: 0,
    });
    // An unnamed baseline is listed under its scope label.
    expect(rows[2]).toEqual({
      id: 'b-under', name: 'View: v1', scope: 'View: v1', source: 'manual', status: 'under',
      currentPerDay: 100, bandLowerPerDay: 150, bandUpperPerDay: 200,
      potentialPerMonth: 0, realizedPerMonth: 3000, dataPoints: 40,
    });
    // Empty filters label as "All"; an empty source defaults to "discovered".
    expect(rows[3]).toEqual({
      id: 'b-flat', name: 'All', scope: 'All', source: 'discovered', status: 'in-band',
      currentPerDay: 100, bandLowerPerDay: 100, bandUpperPerDay: 100,
      potentialPerMonth: 0, realizedPerMonth: 0, dataPoints: 40,
    });
    // Under 30 data points is not enough to judge drift; a non-object scope is "All".
    expect(rows[4]).toMatchObject({ id: 'b-thin', name: 'Thin', scope: 'All', status: 'insufficient-data', dataPoints: 5 });
  });

  it.each([
    ['actionable', ['b-over', 'b-under']],
    ['over', ['b-over']],
    ['under', ['b-under']],
    ['in-band', ['b-flat']],
    ['insufficient-data', ['b-none', 'b-thin']],
  ])('filters by status=%s', async (status, ids) => {
    const out = parseJsonResult(resultText(await listBaselines(ctx, { status, format: 'json' })));
    expect(out.tables[0]?.rows.map(r => r['id'])).toEqual(ids);
  });

  it('keeps only the top `limit` baselines', async () => {
    const out = parseJsonResult(resultText(await listBaselines(ctx, { limit: 2, format: 'json' })));
    expect(out.title).toBe('Cost baselines (2)');
    expect(out.tables[0]?.rows.map(r => r['id'])).toEqual(['b-over', 'b-none']);
  });

  it('says how to get baselines when a filter leaves none', async () => {
    const thinOnly = await stateWith({ specs: JSON.stringify({ baselines: [{ id: 'b1' }] }) });
    expect(resultText(await listBaselines(thinOnly, { status: 'over' }))).toBe(NO_BASELINES);
  });

  it('renders markdown by default and falls back to it for an unknown format', async () => {
    const markdown = resultText(await listBaselines(ctx, {}));
    expect(markdown).toContain('## Cost baselines (5)');
    expect(markdown).toContain('**Total potential**: $1500');
    expect(resultText(await listBaselines(ctx, { format: 'yaml' }))).toBe(markdown);
  });

  it('lists at most 25 baselines by default', async () => {
    const many = await stateWith({
      specs: JSON.stringify({ baselines: Array.from({ length: 26 }, (_, i) => ({ id: `b${String(i)}` })) }),
    });
    const out = parseJsonResult(resultText(await listBaselines(many, { format: 'json' })));
    expect(out.title).toBe('Cost baselines (25)');
    expect(out.tables[0]?.rows).toHaveLength(25);
  });
});

describe('list_baselines with missing or malformed state', () => {
  it.each([
    ['no state files at all', {}],
    ['a corrupt baselines.json', { specs: '{ not json' }],
    ['a baselines.json that is an array', { specs: '[{"id":"b1"}]' }],
    ['a baselines field that is not an array', { specs: '{"baselines":{"id":"b1"}}' }],
  ])('reports no baselines for %s', async (_label, files) => {
    const ctx = await stateWith(files);
    expect(resultText(await listBaselines(ctx, {}))).toBe(NO_BASELINES);
  });

  it('lists the specs when baselines-data.json is missing, corrupt or not an object', async () => {
    const specs = JSON.stringify({ baselines: [{ id: 'b1', name: 'One' }] });
    for (const data of [undefined, '{ not json', '[1, 2]', '{"history": [1], "snapshots": [2]}']) {
      const ctx = await stateWith(data === undefined ? { specs } : { specs, data });
      const out = parseJsonResult(resultText(await listBaselines(ctx, { format: 'json' })));
      expect(out.tables[0]?.rows).toEqual([expect.objectContaining({ id: 'b1', dataPoints: 0, status: 'insufficient-data' })]);
    }
  });

  it('keeps only object history points and reads a non-numeric cost as $0', async () => {
    const ctx = await stateWith({
      specs: JSON.stringify({ baselines: [{ id: 'b1' }, { id: 'b2' }] }),
      data: JSON.stringify({
        history: {
          b1: [{ date: '2026-01-01', cost: 100 }, 'junk', null, [3], { date: '2026-01-02', cost: '7' }],
          b2: 'not-a-list',
        },
      }),
    });
    const rows = parseJsonResult(resultText(await listBaselines(ctx, { format: 'json' }))).tables[0]?.rows ?? [];
    const byId = new Map(rows.map(r => [r['id'], r]));
    // Two points (100 + 0) over a 2-day window: $50/day.
    expect(byId.get('b1')).toMatchObject({ dataPoints: 2, currentPerDay: 50 });
    expect(byId.get('b2')).toMatchObject({ dataPoints: 0, currentPerDay: 0 });
  });

  it('labels a spec with no id and a non-string name by its scope', async () => {
    const ctx = await stateWith({ specs: JSON.stringify({ baselines: [{ name: 42, scope: { filters: { team: ['a', 1] } } }] }) });
    const rows = parseJsonResult(resultText(await listBaselines(ctx, { format: 'json' }))).tables[0]?.rows ?? [];
    expect(rows).toEqual([expect.objectContaining({ id: '', name: 'team=a,1', scope: 'team=a,1', source: 'discovered' })]);
  });

  it('labels a scope whose filters are not an object as All', async () => {
    const ctx = await stateWith({ specs: JSON.stringify({ baselines: [{ id: 'b1', scope: { filters: ['service=EC2'] } }] }) });
    const rows = parseJsonResult(resultText(await listBaselines(ctx, { format: 'json' }))).tables[0]?.rows ?? [];
    expect(rows).toEqual([expect.objectContaining({ id: 'b1', scope: 'All' })]);
  });
});

describe('band configuration', () => {
  // 30 days costing $1..$30. With a 1-day run-rate window the band is read
  // straight off the daily costs and "current" is the last day ($30).
  const RAMP = JSON.stringify({ history: { b1: days(30, i => i + 1) } });
  const specsWith = (extra: Record<string, unknown>): string => JSON.stringify({ baselines: [{ id: 'b1', ...extra }] });

  async function onlyRow(specs: string): Promise<Readonly<Record<string, unknown>>> {
    const ctx = await stateWith({ specs, data: RAMP });
    const row = parseJsonResult(resultText(await listBaselines(ctx, { format: 'json' }))).tables[0]?.rows[0];
    if (row === undefined) throw new Error('no baseline row');
    return row;
  }

  it('uses the defaults (10th/90th percentile, 30-day window) without config or env', async () => {
    // One 30-day run-rate point: the $15.50 average is both band edges and current.
    expect(await onlyRow(specsWith({}))).toMatchObject({
      status: 'in-band', currentPerDay: 15.5, bandLowerPerDay: 15.5, bandUpperPerDay: 15.5, potentialPerMonth: 0,
    });
  });

  it('honours the persisted band config', async () => {
    const row = await onlyRow(JSON.stringify({
      baselines: [{ id: 'b1' }],
      config: { lowerPct: 0, upperPct: 100, windowDays: 1 },
    }));
    expect(row).toMatchObject({
      status: 'in-band', currentPerDay: 30, bandLowerPerDay: 1, bandUpperPerDay: 30, potentialPerMonth: 870, realizedPerMonth: 0,
    });
  });

  it('falls back to the env-configured defaults the desktop store uses', async () => {
    vi.stubEnv('COSTGOBLIN_BASELINES_LOWER_PCT', '50');
    vi.stubEnv('COSTGOBLIN_BASELINES_UPPER_PCT', '50');
    vi.stubEnv('COSTGOBLIN_BASELINES_WINDOW_DAYS', '1');
    // The median of $1..$30 is $15.50: the $30 current is over it.
    expect(await onlyRow(specsWith({}))).toMatchObject({
      status: 'over', currentPerDay: 30, bandLowerPerDay: 15.5, bandUpperPerDay: 15.5, potentialPerMonth: 435,
    });
  });

  it('ignores a non-numeric env value', async () => {
    vi.stubEnv('COSTGOBLIN_BASELINES_LOWER_PCT', 'ten');
    vi.stubEnv('COSTGOBLIN_BASELINES_UPPER_PCT', 'ninety');
    vi.stubEnv('COSTGOBLIN_BASELINES_WINDOW_DAYS', 'abc');
    expect(await onlyRow(specsWith({}))).toMatchObject({ currentPerDay: 15.5, bandLowerPerDay: 15.5 });
  });

  it('lets the persisted config win over the env, field by field', async () => {
    vi.stubEnv('COSTGOBLIN_BASELINES_WINDOW_DAYS', '30');
    const row = await onlyRow(JSON.stringify({
      baselines: [{ id: 'b1' }],
      // A non-numeric field keeps the env/default value for that field only.
      config: { lowerPct: 0, upperPct: '100', windowDays: 1 },
    }));
    // p0 floor ($1), default p90 ceiling of $1..$30 ($27.10), current $30.
    expect(row['bandLowerPerDay']).toBe(1);
    expect(row['bandUpperPerDay']).toBeCloseTo(27.1, 10);
    expect(row).toMatchObject({ status: 'over', currentPerDay: 30, potentialPerMonth: 870 });
  });

  it('resolves a percentile-mode manual band against the run-rate series', async () => {
    const row = await onlyRow(JSON.stringify({
      baselines: [{ id: 'b1', manualBand: { mode: 'percentile', lower: 0, upper: 100 } }],
      config: { windowDays: 1 },
    }));
    expect(row).toMatchObject({ status: 'in-band', bandLowerPerDay: 1, bandUpperPerDay: 30, potentialPerMonth: 870 });
  });

  it('keeps the env value for each config field that is not a number', async () => {
    vi.stubEnv('COSTGOBLIN_BASELINES_LOWER_PCT', '0');
    vi.stubEnv('COSTGOBLIN_BASELINES_WINDOW_DAYS', '1');
    const row = await onlyRow(JSON.stringify({
      baselines: [{ id: 'b1' }],
      config: { lowerPct: 'zero', upperPct: 100, windowDays: 'one' },
    }));
    expect(row).toMatchObject({ status: 'in-band', bandLowerPerDay: 1, bandUpperPerDay: 30, potentialPerMonth: 870 });
  });

  it('lets a partial absolute override replace only the floor it sets', async () => {
    const row = await onlyRow(JSON.stringify({
      baselines: [{ id: 'b1', manualBand: { mode: 'absolute', lower: 10, upper: 'high' } }],
      config: { windowDays: 1 },
    }));
    expect(row['bandLowerPerDay']).toBe(10);
    expect(row['bandUpperPerDay']).toBeCloseTo(27.1, 10);
    expect(row).toMatchObject({ status: 'over', potentialPerMonth: 600 });
  });

  it('lets a partial absolute override replace only the ceiling it sets', async () => {
    const row = await onlyRow(JSON.stringify({
      baselines: [{ id: 'b1', manualBand: { mode: 'absolute', upper: 25 } }],
      config: { windowDays: 1 },
    }));
    // The automated p10 floor of $1..$30 stays; current $30 is over the $25 ceiling.
    expect(row['bandLowerPerDay']).toBeCloseTo(3.9, 10);
    expect(row['potentialPerMonth']).toBeCloseTo(783, 8);
    expect(row).toMatchObject({ status: 'over', bandUpperPerDay: 25, realizedPerMonth: 0 });
  });

  it('ignores a manual band that is not an object', async () => {
    const row = await onlyRow(JSON.stringify({ baselines: [{ id: 'b1', manualBand: 'absolute' }], config: { windowDays: 1 } }));
    expect(row['bandLowerPerDay']).toBeCloseTo(3.9, 10);
    expect(row['bandUpperPerDay']).toBeCloseTo(27.1, 10);
  });
});

describe('get_baseline_drift', () => {
  const flat = days(40, () => 100);
  const snapshots = Array.from({ length: 12 }, (_, i) => ({
    date: `2026-02-${String(i + 1).padStart(2, '0')}`,
    current: 100 + i,
    status: i % 2 === 0 ? 'over' : 'in-band',
  }));
  const SPECS = JSON.stringify({
    baselines: [
      {
        id: 'b-over',
        name: 'Compute',
        scope: { filters: { service: ['EC2', 'EBS'] } },
        manualBand: { mode: 'absolute', lower: 50, upper: 80 },
      },
      { id: 'b-view', scope: { kind: 'view' } },
      { id: 'b-odd', name: 'Odd snapshots' },
    ],
  });
  const DATA = JSON.stringify({
    history: { 'b-over': flat, 'b-view': flat },
    snapshots: {
      'b-over': snapshots,
      'b-odd': [{ date: 20260201, current: '__INF__', status: null }, 'junk', { date: '2026-02-02', current: 'x' }],
      'b-view': 'not-a-list',
    },
  // 1e999 parses as Infinity: a number, but not a finite one, so it reads as $0.
  }).replace('"__INF__"', '1e999');

  let ctx: McpContext;
  beforeAll(async () => {
    ctx = await stateWith({ specs: SPECS, data: DATA });
  });

  it('asks for an id or a match when given neither', async () => {
    const expected = 'Specify either `id` or a non-empty `match` to identify a baseline. Use list_baselines to see available scopes.';
    expect(resultText(await getBaselineDrift(ctx, {}))).toBe(expected);
    // A whitespace-only match is no match: it must not select an arbitrary baseline.
    expect(resultText(await getBaselineDrift(ctx, { match: '   ' }))).toBe(expected);
  });

  it.each([
    ['an unknown id', { id: 'nope' }],
    ['a match nothing contains', { match: 'lambda' }],
  ])('reports no match for %s', async (_label, params) => {
    expect(resultText(await getBaselineDrift(ctx, params))).toBe('No matching baseline. Use list_baselines to see available scopes.');
  });

  it('shows the band, savings and the last 10 snapshots of a baseline found by id', async () => {
    const out = parseJsonResult(resultText(await getBaselineDrift(ctx, { id: 'b-over', format: 'json' })));
    expect(out.title).toBe('Baseline drift — Compute');
    expect(Object.fromEntries(out.meta)).toEqual({
      'Scope': 'service=EC2,EBS',
      'Status': 'over',
      'Current/day': 100,
      'Band low/day': 50,
      'Band high/day': 80,
      'Potential/mo': 1500,
      'Realized/mo': 0,
    });
    const table = out.tables[0];
    expect(table?.title).toBe('Recent snapshots');
    expect(table?.rows.map(r => r['date'])).toEqual(snapshots.slice(-10).map(s => s.date));
    expect(table?.rows[0]).toEqual({ date: '2026-02-03', current: 102, status: 'over' });
    expect(out.notes).toEqual([]);
  });

  it('matches the name case-insensitively', async () => {
    const out = parseJsonResult(resultText(await getBaselineDrift(ctx, { match: '  COMP ', format: 'json' })));
    expect(out.title).toBe('Baseline drift — Compute');
  });

  it('falls back to the scope label when the name does not match', async () => {
    const out = parseJsonResult(resultText(await getBaselineDrift(ctx, { match: 'ebs', format: 'json' })));
    expect(out.title).toBe('Baseline drift — Compute');
  });

  it('matches an unnamed baseline on its scope label and notes the missing snapshots', async () => {
    const out = parseJsonResult(resultText(await getBaselineDrift(ctx, { match: 'view:', format: 'json' })));
    expect(out.title).toBe('Baseline drift — View: ');
    expect(out.meta.get('Status')).toBe('in-band');
    expect(out.tables).toEqual([]);
    expect(out.notes).toEqual(['_No snapshot history yet._']);
  });

  it('reads malformed snapshot fields as empty / $0 and skips non-object snapshots', async () => {
    const out = parseJsonResult(resultText(await getBaselineDrift(ctx, { id: 'b-odd', format: 'json' })));
    expect(out.meta.get('Status')).toBe('insufficient-data');
    expect(out.tables[0]?.rows).toEqual([
      { date: '', current: 0, status: '' },
      { date: '2026-02-02', current: 0, status: '' },
    ]);
  });

  it('renders markdown by default', async () => {
    const text = resultText(await getBaselineDrift(ctx, { id: 'b-over' }));
    expect(text).toContain('## Baseline drift — Compute');
    expect(text).toContain('**Potential/mo**: $1500');
    expect(text).toContain('### Recent snapshots');
  });
});
