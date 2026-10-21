import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../config/validator.js';
import { loadSavingsRecommendations } from '../savings/snapshots.js';
import type { ProviderConfig } from '../types/config.js';

// loadSavingsRecommendations across providers: which snapshot each one reads,
// a provider that fails, and two providers syncing the same COH export. The
// query runner is faked by provider path; the handler and MCP tests run the
// real SQL in DuckDB.

type Row = Readonly<Record<string, unknown>>;

/** An AWS provider; with a cost-optimization tier, it syncs `costOptExport`
 *  (each provider its own export unless one is named). */
function provider(name: string, costOptimization: boolean, costOptExport = `s3://bucket/${name}/cost-opt/`): Record<string, unknown> {
  return {
    name,
    type: 'aws',
    credentialsProfile: 'test-profile',
    sync: {
      daily: { bucket: `s3://bucket/${name}/daily/`, retentionDays: 365 },
      ...(costOptimization ? { costOptimization: { bucket: costOptExport, retentionDays: 90 } } : {}),
      intervalMinutes: 60,
    },
  };
}

const SHARED_EXPORT = 's3://payer-exports/cost-optimization/';

function providers(...entries: readonly Record<string, unknown>[]): readonly ProviderConfig[] {
  return validateConfig({ providers: entries, defaults: { periodDays: 30, costMetric: 'unblended_cost', lagDays: 1 } }).providers;
}

function row(id: string, savings: number): Row {
  return { recommendation_id: id, action_type: 'Delete', current_resource_type: 'EbsVolume', resource_arn: `arn:${id}`, monthly_savings: savings, monthly_cost: savings };
}

let dataDir: string;

async function snapshot(name: string, date: string): Promise<void> {
  const dir = join(dataDir, name, 'raw', `cost-opt-${date}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'part-0.parquet'), '');
}

/** Answers each provider's snapshot query from `rows`, recording the providers asked. */
function runner(rows: Readonly<Record<string, readonly Row[] | Error>>, asked: string[]): (sql: string) => Promise<readonly Row[]> {
  return (sql) => {
    const name = Object.keys(rows).find(n => sql.includes(`/${n}/raw/cost-opt-`));
    if (name === undefined) return Promise.reject(new Error(`unexpected query: ${sql}`));
    asked.push(name);
    const answer = rows[name];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? []);
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cg-savings-load-'));
  await snapshot('aws-a', '2026-10-12');
  await snapshot('aws-b', '2026-10-13');
  await snapshot('aws-c', '2026-10-13');
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('loadSavingsRecommendations', () => {
  it('reads every provider with a cost-optimization tier, newest snapshot first', async () => {
    const asked: string[] = [];
    const loaded = await loadSavingsRecommendations(
      dataDir,
      providers(provider('aws-a', true), provider('aws-b', true), provider('aws-c', false)),
      runner({ 'aws-a': [row('a1', 3)], 'aws-b': [row('b1', 5)] }, asked),
    );
    expect(asked.sort()).toEqual(['aws-a', 'aws-b']);
    expect(loaded.snapshots).toEqual([{ providerName: 'aws-b', date: '2026-10-13' }, { providerName: 'aws-a', date: '2026-10-12' }]);
    expect(loaded.recommendations.map(r => [r.providerName, r.recommendationId])).toEqual([['aws-b', 'b1'], ['aws-a', 'a1']]);
  });

  it('reads only the newest snapshot of two providers that sync the same export', async () => {
    // aws-a stopped syncing on Oct 12 (its bucket path differs only by the
    // trailing slash). Three of its four recommendations were implemented
    // since: none may come back, and the remaining one keeps aws-b's value.
    const loaded = await loadSavingsRecommendations(
      dataDir,
      providers(provider('aws-a', true, SHARED_EXPORT.slice(0, -1)), provider('aws-b', true, SHARED_EXPORT)),
      runner({ 'aws-a': [row('kept', 9), row('done-1', 4), row('done-2', 3), row('done-3', 2)], 'aws-b': [row('kept', 7)] }, []),
    );
    expect(loaded.snapshots).toEqual([{ providerName: 'aws-b', date: '2026-10-13' }]);
    expect(loaded.recommendations.map(r => [r.recommendationId, r.monthlySavings])).toEqual([['kept', 7]]);

    // Everything implemented: the newer snapshot is empty, and still current.
    const allDone = await loadSavingsRecommendations(
      dataDir,
      providers(provider('aws-a', true, SHARED_EXPORT), provider('aws-b', true, SHARED_EXPORT)),
      runner({ 'aws-a': [row('done-1', 4)], 'aws-b': [] }, []),
    );
    expect(allDone).toEqual({ recommendations: [], snapshots: [{ providerName: 'aws-b', date: '2026-10-13' }] });
  });

  it('keeps a provider whose different export shares recommendations with a newer one, listing each once', async () => {
    // aws-b is a member account's own export; aws-a, the payer's, also
    // lists that account's recommendation next to every other account's.
    const loaded = await loadSavingsRecommendations(
      dataDir,
      providers(provider('aws-a', true), provider('aws-b', true)),
      runner({ 'aws-a': [row('member', 9), row('p1', 4), row('p2', 3), row('p3', 2)], 'aws-b': [row('member', 7)] }, []),
    );
    expect(loaded.snapshots).toEqual([{ providerName: 'aws-b', date: '2026-10-13' }, { providerName: 'aws-a', date: '2026-10-12' }]);
    expect(loaded.recommendations.map(r => [r.providerName, r.recommendationId, r.monthlySavings])).toEqual([
      ['aws-b', 'member', 7], ['aws-a', 'p1', 4], ['aws-a', 'p2', 3], ['aws-a', 'p3', 2],
    ]);
  });

  it('leaves out a provider whose snapshot cannot be read, not the others', async () => {
    const loaded = await loadSavingsRecommendations(
      dataDir,
      providers(provider('aws-a', true), provider('aws-b', true)),
      runner({ 'aws-a': new Error('Invalid Input Error: No magic bytes found at end of file'), 'aws-b': [row('b1', 5)] }, []),
    );
    expect(loaded.snapshots).toEqual([{ providerName: 'aws-b', date: '2026-10-13' }]);
    expect(loaded.recommendations.map(r => r.recommendationId)).toEqual(['b1']);
  });

  it('is empty when no provider has synced a snapshot', async () => {
    const asked: string[] = [];
    const loaded = await loadSavingsRecommendations(dataDir, providers(provider('aws-z', true)), runner({}, asked));
    expect(loaded).toEqual({ recommendations: [], snapshots: [] });
    expect(asked).toEqual([]);
  });
});
