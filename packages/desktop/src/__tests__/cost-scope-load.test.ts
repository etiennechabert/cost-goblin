import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, DEFAULT_COST_SCOPE, loadCostScope, mergeBuiltInExclusionRules } from '@costgoblin/core';
import type { CostScopeConfig } from '@costgoblin/core';
import { CostScopeLoadError, costScopeForQueries, loadOrSeedCostScope } from '../main/handlers/cost-scope-load.js';
import type { CostScopeSource } from '../main/handlers/cost-scope-load.js';

let dir: string;
let costScopePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-cost-scope-load-'));
  costScopePath = join(dir, 'cost-scope.yaml');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The app's loader: cost-scope.yaml read, validated and merged with the
 *  built-in rules, as createAppContext wires it (minus the cache). */
async function loadFromDisk(): Promise<CostScopeConfig> {
  return mergeBuiltInExclusionRules(await loadCostScope(costScopePath));
}

function source(getCostScope: () => Promise<CostScopeConfig> = loadFromDisk): CostScopeSource {
  return { costScopePath, getCostScope };
}

/** A hand-maintained cost-scope.yaml: the list metric and a custom rule. */
const CUSTOM_COST_SCOPE_YAML = `costMetric: list
lagDays: 3
rules:
  - id: user:sandbox
    name: Sandbox accounts
    enabled: true
    builtIn: false
    conditions:
      - dimensionId: account
        values:
          - Data Analytics
`;

function edited(from: string, to: string): string {
  if (!CUSTOM_COST_SCOPE_YAML.includes(from)) throw new Error(`fixture has no "${from}"`);
  return CUSTOM_COST_SCOPE_YAML.replace(from, to);
}

// Each of these used to be read as "no cost scope": every query dropped the
// rules and metric above, and the Cost Scope page could save the defaults
// over the file.
const BROKEN_FILES = [
  { edit: 'a scalar where a list goes', yaml: edited('values:\n          - Data Analytics', 'values: Data Analytics'), error: /rules\[0\]\.conditions\[0\]\.values must be an array/ },
  { edit: 'an unknown cost metric', yaml: edited('costMetric: list', 'costMetric: lisst'), error: /costMetric must be one of/ },
  { edit: 'a negative lag', yaml: edited('lagDays: 3', 'lagDays: -3'), error: /lagDays must be a non-negative integer/ },
  { edit: 'a YAML syntax error', yaml: edited('name: Sandbox accounts', 'name: "Sandbox accounts'), error: /Missing closing "quote/ },
];

const enoent = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));

// Write-only: the read fails with EACCES while a write would still succeed,
// so only the error code keeps the defaults off the file. Root reads it
// anyway, so the case can't be built there.
const canBuildUnreadable = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('loadOrSeedCostScope', () => {
  it('writes the defaults when cost-scope.yaml does not exist', async () => {
    const costScope = await loadOrSeedCostScope(source());

    expect(costScope).toEqual(DEFAULT_COST_SCOPE);
    expect(await loadFromDisk()).toEqual(DEFAULT_COST_SCOPE);
  });

  it('returns a valid cost-scope.yaml and leaves it as it is', async () => {
    await writeFile(costScopePath, CUSTOM_COST_SCOPE_YAML);

    const costScope = await loadOrSeedCostScope(source());

    expect(costScope.costMetric).toBe('list');
    expect(costScope.rules.map(r => r.id)).toContain('user:sandbox');
    expect(await readFile(costScopePath, 'utf-8')).toBe(CUSTOM_COST_SCOPE_YAML);
  });

  it.each(BROKEN_FILES)('rejects a cost-scope.yaml with $edit and leaves the file untouched', async ({ yaml, error }) => {
    await writeFile(costScopePath, yaml);

    await expect(loadOrSeedCostScope(source())).rejects.toThrow(error);

    expect(await readFile(costScopePath, 'utf-8')).toBe(yaml);
  });

  it.skipIf(!canBuildUnreadable)('rejects a cost-scope.yaml it cannot read and leaves it untouched', async () => {
    await writeFile(costScopePath, CUSTOM_COST_SCOPE_YAML);
    await chmod(costScopePath, 0o200);

    await expect(loadOrSeedCostScope(source())).rejects.toMatchObject({ code: 'EACCES' });

    await chmod(costScopePath, 0o600);
    expect(await readFile(costScopePath, 'utf-8')).toBe(CUSTOM_COST_SCOPE_YAML);
  });

  it('loads a cost-scope.yaml that appeared after the failed read rather than replacing it', async () => {
    await writeFile(costScopePath, CUSTOM_COST_SCOPE_YAML);
    // The first read reports the file missing, as it was a moment before.
    let reads = 0;
    const racing = source(() => {
      reads++;
      return reads === 1 ? enoent() : loadFromDisk();
    });

    const costScope = await loadOrSeedCostScope(racing);

    expect(costScope.costMetric).toBe('list');
    expect(await readFile(costScopePath, 'utf-8')).toBe(CUSTOM_COST_SCOPE_YAML);
  });
});

describe('costScopeForQueries', () => {
  it('applies a valid cost-scope.yaml', async () => {
    await writeFile(costScopePath, CUSTOM_COST_SCOPE_YAML);

    const costScope = await costScopeForQueries(loadFromDisk);

    expect(costScope.costMetric).toBe('list');
    expect(costScope.rules.find(r => r.id === 'user:sandbox')?.enabled).toBe(true);
  });

  it('applies the defaults while cost-scope.yaml does not exist, the ones seeding then writes', async () => {
    const whileMissing = await costScopeForQueries(loadFromDisk);
    expect(whileMissing).toEqual(DEFAULT_COST_SCOPE);

    // Seeding the file changes nothing the queries (and the rollup built
    // from them) already applied.
    await loadOrSeedCostScope(source());
    expect(await costScopeForQueries(loadFromDisk)).toEqual(whileMissing);
  });

  it.each(BROKEN_FILES)('fails, naming cost-scope.yaml, on a file with $edit instead of running unscoped', async ({ yaml, error }) => {
    await writeFile(costScopePath, yaml);

    const failed = costScopeForQueries(loadFromDisk);

    await expect(failed).rejects.toThrow(CostScopeLoadError);
    await expect(failed).rejects.toThrow(/^Couldn't load cost-scope\.yaml: /);
    await expect(failed).rejects.toThrow(error);
  });

  it('keeps the load error as the cause', async () => {
    const invalid = new ConfigValidationError('costScope.rules must be an array');

    const failed = costScopeForQueries(() => Promise.reject(invalid));

    await expect(failed).rejects.toMatchObject({
      name: 'CostScopeLoadError',
      message: "Couldn't load cost-scope.yaml: costScope.rules must be an array",
      cause: invalid,
    });
  });

  it.skipIf(!canBuildUnreadable)('fails on a cost-scope.yaml it cannot read', async () => {
    await writeFile(costScopePath, CUSTOM_COST_SCOPE_YAML);
    await chmod(costScopePath, 0o200);

    const failed = costScopeForQueries(loadFromDisk);

    await expect(failed).rejects.toThrow(CostScopeLoadError);
    await expect(failed).rejects.toMatchObject({ cause: { code: 'EACCES' } });
    await chmod(costScopePath, 0o600);
  });
});
