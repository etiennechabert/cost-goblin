import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpContext } from '../context.js';
import { getBaselineDrift, listBaselines } from '../tools/baselines.js';

/** The tools read baselines-data.json themselves. A persisted date that isn't a
 *  calendar day reached computeCurrent as an invalid Date and threw, so
 *  list_baselines failed for every baseline and get_baseline_drift for this one. */
describe('baselines tools over malformed persisted history', () => {
  let stateDir: string;
  let ctx: McpContext;

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cg-mcp-baselines-'));
    await writeFile(join(stateDir, 'baselines.json'), JSON.stringify({
      baselines: [{ id: 'b1', source: 'manual', scope: { kind: 'filter', filters: { service: ['EC2'] } } }],
    }));
    await writeFile(join(stateDir, 'baselines-data.json'), JSON.stringify({
      history: {
        b1: [
          { date: 7, cost: 1 },
          { date: '2026-02-01', cost: 10 },
          { date: 'garbage', cost: 1 },
          { date: '2026-02-02', cost: 20 },
          { date: '2026-02-31', cost: 1 },
        ],
      },
    }));
    const stub = (): never => { throw new Error('not used by the baselines tools'); };
    ctx = {
      dataDir: stateDir,
      stateDir,
      runQuery: stub,
      runPreparedQuery: stub,
      getConfig: stub,
      getDimensions: stub,
      getQueryDimensions: stub,
      getCostScope: stub,
      getAccountMap: stub,
      getAccountReverseMap: stub,
      getOrgAccountsPath: stub,
      materializedBase: { getSource: () => undefined },
      warmup: () => Promise.resolve(),
      now: () => Date.now(),
    };
  });

  afterAll(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('list_baselines derives the baseline from its valid points alone', async () => {
    const parsed: unknown = JSON.parse((await listBaselines(ctx, { format: 'json' })).content[0].text);
    expect(parsed).toMatchObject({
      tables: [{
        rows: [[
          'b1', 'service=EC2', 'service=EC2', 'manual', 'insufficient-data',
          15, expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), 2,
        ]],
      }],
    });
  });

  it('get_baseline_drift resolves for it', async () => {
    const parsed: unknown = JSON.parse((await getBaselineDrift(ctx, { id: 'b1', format: 'json' })).content[0].text);
    expect(parsed).toMatchObject({
      title: 'Baseline drift — service=EC2',
      meta: expect.arrayContaining([{ label: 'Current/day', value: 15, type: 'currency' }]),
    });
  });
});
