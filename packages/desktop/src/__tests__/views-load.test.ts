import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_VIEWS_CONFIG, loadViews } from '@costgoblin/core';
import type { ViewsConfig } from '@costgoblin/core';
import { loadOrSeedViews } from '../main/handlers/views-load.js';
import type { ViewsSource } from '../main/handlers/views-load.js';

let dir: string;
let viewsPath: string;
let invalidations: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-views-load-'));
  viewsPath = join(dir, 'views.yaml');
  invalidations = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The app's source: getViews reads and validates views.yaml through
 *  loadViews, as createAppContext wires it (minus the cache). */
function source(getViews: () => Promise<ViewsConfig> = () => loadViews(viewsPath)): ViewsSource {
  return { viewsPath, getViews, invalidateViews: () => { invalidations++; } };
}

/** A hand-maintained views.yaml: a custom dashboard next to a built-in one. */
const CUSTOM_VIEWS_YAML = `views:
  - id: overview
    name: Cost Overview
    builtIn: true
    rows:
      - widgets:
          - id: overview-summary
            type: summary
            size: small
  - id: team-costs
    name: Team costs
    rows:
      - widgets:
          - id: team-top
            type: topNBar
            size: large
            groupBy: service
            topN: 5
          - id: team-pie
            type: pie
            size: medium
            groupBy: account
`;

function edited(from: string, to: string): string {
  if (!CUSTOM_VIEWS_YAML.includes(from)) throw new Error(`fixture has no "${from}"`);
  return CUSTOM_VIEWS_YAML.replace(from, to);
}

describe('loadOrSeedViews', () => {
  it('writes the seed views when views.yaml does not exist', async () => {
    const views = await loadOrSeedViews(source());

    expect(views).toEqual(SEED_VIEWS_CONFIG);
    expect(await loadViews(viewsPath)).toEqual(SEED_VIEWS_CONFIG);
    expect(invalidations).toBe(1);
  });

  it('returns a valid views.yaml and leaves it as it is', async () => {
    await writeFile(viewsPath, CUSTOM_VIEWS_YAML);

    const views = await loadOrSeedViews(source());

    expect(views.views.map(v => v.id)).toEqual(['overview', 'team-costs']);
    expect(await readFile(viewsPath, 'utf-8')).toBe(CUSTOM_VIEWS_YAML);
    expect(invalidations).toBe(0);
  });

  // Each of these used to be "seeded": views.yaml was replaced by the default
  // views, and every custom dashboard in it was deleted with no backup.
  it.each([
    { edit: 'a string topN', yaml: edited('topN: 5', 'topN: "5"'), error: /widgets\[0\]\.topN must be a number/ },
    { edit: 'an unknown size', yaml: edited('size: large', 'size: jumbo'), error: /widgets\[0\]\.size must be one of/ },
    { edit: 'an unknown widget type', yaml: edited('type: pie', 'type: sparkline'), error: /widgets\[1\]\.type must be one of/ },
    { edit: 'a duplicate widget id', yaml: edited('id: team-pie', 'id: team-top'), error: /duplicate widget id "team-top"/ },
    { edit: 'a YAML syntax error', yaml: edited('name: Team costs', 'name: "Team costs'), error: /Missing closing "quote/ },
  ])('rejects a views.yaml with $edit and leaves the file untouched', async ({ yaml, error }) => {
    await writeFile(viewsPath, yaml);

    await expect(loadOrSeedViews(source())).rejects.toThrow(error);

    expect(await readFile(viewsPath, 'utf-8')).toBe(yaml);
    expect(invalidations).toBe(0);
  });

  // Write-only: the read fails with EACCES while a write would still succeed,
  // so only the error code keeps the seed off the file. Root reads it anyway,
  // so the case can't be built there.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects a views.yaml it cannot read and leaves it untouched', async () => {
    await writeFile(viewsPath, CUSTOM_VIEWS_YAML);
    await chmod(viewsPath, 0o200);

    await expect(loadOrSeedViews(source())).rejects.toMatchObject({ code: 'EACCES' });

    await chmod(viewsPath, 0o600);
    expect(await readFile(viewsPath, 'utf-8')).toBe(CUSTOM_VIEWS_YAML);
    expect(invalidations).toBe(0);
  });

  it('loads a views.yaml that appeared after the failed read rather than replacing it', async () => {
    await writeFile(viewsPath, CUSTOM_VIEWS_YAML);
    // The first read reports the file missing, as it was a moment before.
    let reads = 0;
    const racing = source(() => {
      reads++;
      return reads === 1
        ? Promise.reject(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }))
        : loadViews(viewsPath);
    });

    const views = await loadOrSeedViews(racing);

    expect(views.views.map(v => v.id)).toEqual(['overview', 'team-costs']);
    expect(await readFile(viewsPath, 'utf-8')).toBe(CUSTOM_VIEWS_YAML);
  });
});
