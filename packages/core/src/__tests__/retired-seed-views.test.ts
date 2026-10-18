import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { migrateRetiredSeedViews } from '../config/retired-seed-views.js';
import { validateViews } from '../config/views-validator.js';
import { OVERVIEW_SEED_VIEW, SEED_VIEWS_CONFIG } from '../types/seed-views.js';
import type { ViewSpec, ViewsConfig } from '../types/views.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__', 'views');

/** A views.yaml an older version seeded, loaded the way the desktop loads it. */
function loadSeeded(name: string): ViewsConfig {
  return validateViews(parse(readFileSync(join(fixturesDir, name), 'utf-8')));
}

function retiredView(id: string): ViewSpec {
  const view = loadSeeded('seeded-v0.7.0.yaml').views.find(v => v.id === id);
  if (view === undefined) throw new Error(`fixture has no "${id}" view`);
  return view;
}

const SEED_IDS = SEED_VIEWS_CONFIG.views.map(v => v.id);
const MY_VIEW: ViewSpec = {
  id: 'my-view',
  name: 'Mine',
  rows: [{ widgets: [{ id: 'mine-summary', type: 'summary', size: 'small' }] }],
};

describe('migrateRetiredSeedViews', () => {
  it.each(['seeded-v0.7.0.yaml', 'seeded-v0.5.3.yaml'])('turns an untouched %s into the current built-in set', name => {
    const { config, changed } = migrateRetiredSeedViews(loadSeeded(name));
    expect(changed).toBe(true);
    expect(config).toEqual(SEED_VIEWS_CONFIG);
  });

  it('keeps an edited retired dashboard in place as the user\'s own', () => {
    const legacy = loadSeeded('seeded-v0.7.0.yaml');
    const edited: ViewsConfig = {
      views: [...legacy.views.map(v => (v.id === 'top-n' ? { ...v, name: 'Top spenders' } : v)), MY_VIEW],
    };

    const { config, changed } = migrateRetiredSeedViews(edited);

    expect(changed).toBe(true);
    expect(config.views.map(v => v.id)).toEqual([...SEED_IDS, 'top-n', 'my-view']);
    const kept = config.views.find(v => v.id === 'top-n');
    expect(kept?.name).toBe('Top spenders');
    expect(kept?.builtIn).toBeUndefined();
    expect(config.views.at(-1)).toBe(MY_VIEW);
  });

  it('restores the built-ins in seed order when the file has lost the overview', () => {
    const { config } = migrateRetiredSeedViews({ views: [retiredView('movers'), MY_VIEW] });
    expect(config.views.map(v => v.id)).toEqual([...SEED_IDS, 'my-view']);
  });

  it('leaves a user dashboard that happens to use a retired id alone', () => {
    const mine: ViewsConfig = { views: [OVERVIEW_SEED_VIEW, { ...retiredView('heatmap'), builtIn: undefined }] };
    const result = migrateRetiredSeedViews(mine);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(mine);
  });

  it('leaves a config without retired dashboards alone, even one missing a built-in', () => {
    const current: ViewsConfig = { views: [OVERVIEW_SEED_VIEW, MY_VIEW] };
    const result = migrateRetiredSeedViews(current);
    expect(result.changed).toBe(false);
    expect(result.config).toBe(current);
  });

  it('is idempotent', () => {
    const once = migrateRetiredSeedViews(loadSeeded('seeded-v0.7.0.yaml')).config;
    expect(migrateRetiredSeedViews(once)).toEqual({ config: once, changed: false });
  });
});
