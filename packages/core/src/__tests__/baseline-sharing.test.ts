import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfigBundle, DEFAULT_COST_SCOPE, loadConfig, loadDimensions, parseConfigBundle, serializeConfigBundle, validateBaselines } from '../config/index.js';
import type { BaselineSpec } from '../types/index.js';
import { asDimensionId, asTagValue } from '../types/index.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__', 'config');

function sampleSpec(): BaselineSpec {
  return {
    id: 'bl-1',
    name: 'RDS baseline',
    source: 'discovered',
    scope: { kind: 'filter', filters: { [asDimensionId('service')]: [asTagValue('AmazonRDS')] } },
    // A real baseline snapshots the active cost scope, which always carries the
    // marketplace-attribution default — mirror that so the bundle round-trips.
    basis: { costMetric: 'amortized', costPerspective: 'gross', rules: [], marketplaceAttribution: DEFAULT_COST_SCOPE.marketplaceAttribution },
    basisSnapshotAt: '2026-06-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

describe('baselines bundle section', () => {
  it('round-trips baseline specs through the bundle with a valid fingerprint', async () => {
    const [config, dimensions] = await Promise.all([
      loadConfig(join(fixturesDir, 'costgoblin.yaml')),
      loadDimensions(join(fixturesDir, 'dimensions.yaml')),
    ]);
    const bundle = buildConfigBundle({
      config,
      dimensions,
      baselines: [sampleSpec()],
      appVersion: '0.0.0-test',
      exportedAt: '2026-06-11T00:00:00.000Z',
    });
    expect(bundle.sections.baselines).toHaveLength(1);

    const parsed = parseConfigBundle(serializeConfigBundle(bundle));
    expect(parsed.fingerprintValid).toBe(true);
    const out = parsed.bundle.sections.baselines?.[0];
    expect(out?.id).toBe('bl-1');
    expect(out?.name).toBe('RDS baseline');
    expect(out?.source).toBe('discovered');
    expect(out?.scope).toEqual({ kind: 'filter', filters: { service: ['AmazonRDS'] } });
    expect(out?.basis.costMetric).toBe('amortized');
  });

  it('omits the baselines section when empty', async () => {
    const [config, dimensions] = await Promise.all([
      loadConfig(join(fixturesDir, 'costgoblin.yaml')),
      loadDimensions(join(fixturesDir, 'dimensions.yaml')),
    ]);
    const bundle = buildConfigBundle({ config, dimensions, baselines: [], appVersion: '0.0.0-test' });
    expect(bundle.sections.baselines).toBeUndefined();
  });

  it('rejects a scope filter keyed by a tag dimension', async () => {
    const dimensions = await loadDimensions(join(fixturesDir, 'dimensions.yaml'));
    const raw = {
      baselines: [
        {
          id: 'x',
          source: 'manual',
          scope: { kind: 'filter', filters: { team: ['core'] } },
          basis: { costMetric: 'unblended', rules: [] },
          basisSnapshotAt: 't',
          createdAt: 't',
          updatedAt: 't',
        },
      ],
    };
    expect(() => validateBaselines(raw, dimensions)).toThrow(/built-in/);
  });
});
