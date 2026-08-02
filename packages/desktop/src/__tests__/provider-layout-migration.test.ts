import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateProviderLayoutSync } from '../main/provider-layout-migration.js';

const CONFIG_WITH = (name: string): string => `providers:
  - name: ${name}
    type: aws
    credentialsProfile: p
    sync:
      daily:
        bucket: s3://b/daily
        retentionDays: 30
      intervalMinutes: 60
defaults:
  periodDays: 30
  costMetric: unblended_cost
  lagDays: 1
`;

describe('migrateProviderLayoutSync', () => {
  let base: string;
  let dataDir: string;
  let configPath: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cg-provider-migration-'));
    dataDir = join(base, 'data');
    configPath = join(base, 'config', 'costgoblin.yaml');
    mkdirSync(join(base, 'config'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function seedLegacyTree(): void {
    mkdirSync(join(dataDir, 'aws', 'raw', 'daily-2026-01'), { recursive: true });
    writeFileSync(join(dataDir, 'aws', 'raw', 'daily-2026-01', 'data.parquet'), 'parquet');
    mkdirSync(join(dataDir, 'aws', 'rollup', 'daily-2026-01'), { recursive: true });
    writeFileSync(join(dataDir, 'aws', 'rollup', 'manifest.json'), '{}');
    writeFileSync(join(dataDir, 'sync-etags.json'), '{"2026-01":{}}');
    writeFileSync(join(dataDir, 'sync-timestamps.json'), '{"daily":"2026-01-01T00:00:00Z"}');
  }

  it('renames data/aws to the first provider name and moves root sidecars into meta/', () => {
    writeFileSync(configPath, CONFIG_WITH('aws-main'));
    seedLegacyTree();

    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(true);

    expect(existsSync(join(dataDir, 'aws'))).toBe(false);
    expect(existsSync(join(dataDir, 'aws-main', 'raw', 'daily-2026-01', 'data.parquet'))).toBe(true);
    expect(existsSync(join(dataDir, 'aws-main', 'rollup', 'manifest.json'))).toBe(true);
    expect(readFileSync(join(dataDir, 'aws-main', 'meta', 'sync-etags.json'), 'utf-8')).toBe('{"2026-01":{}}');
    expect(existsSync(join(dataDir, 'aws-main', 'meta', 'sync-timestamps.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'sync-etags.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'sync-timestamps.json'))).toBe(false);
  });

  it('is idempotent — a second run is a no-op', () => {
    writeFileSync(configPath, CONFIG_WITH('aws-main'));
    seedLegacyTree();
    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(true);
    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(false);
    expect(existsSync(join(dataDir, 'aws-main', 'raw', 'daily-2026-01', 'data.parquet'))).toBe(true);
  });

  it('with a provider named aws, keeps the dir and only moves sidecars', () => {
    writeFileSync(configPath, CONFIG_WITH('aws'));
    seedLegacyTree();

    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(true);

    expect(existsSync(join(dataDir, 'aws', 'raw', 'daily-2026-01', 'data.parquet'))).toBe(true);
    expect(existsSync(join(dataDir, 'aws', 'meta', 'sync-etags.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'sync-etags.json'))).toBe(false);
  });

  it('resumes after a partial run (dir renamed, sidecars still at root)', () => {
    writeFileSync(configPath, CONFIG_WITH('aws-main'));
    seedLegacyTree();
    // Simulate the crash point: dir rename happened, sidecar moves did not.
    mkdirSync(join(dataDir, 'aws-main'), { recursive: true });
    rmSync(join(dataDir, 'aws'), { recursive: true, force: true });

    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(true);
    expect(existsSync(join(dataDir, 'aws-main', 'meta', 'sync-etags.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'sync-etags.json'))).toBe(false);
  });

  it('never touches the legacy dir when the provider dir also exists', () => {
    writeFileSync(configPath, CONFIG_WITH('aws-main'));
    seedLegacyTree();
    mkdirSync(join(dataDir, 'aws-main', 'raw'), { recursive: true });
    writeFileSync(join(dataDir, 'aws-main', 'raw', 'existing.txt'), 'keep');

    migrateProviderLayoutSync(dataDir, configPath);

    expect(existsSync(join(dataDir, 'aws', 'raw', 'daily-2026-01', 'data.parquet'))).toBe(true);
    expect(readFileSync(join(dataDir, 'aws-main', 'raw', 'existing.txt'), 'utf-8')).toBe('keep');
  });

  it('prefers an existing meta sidecar over the stale root copy', () => {
    writeFileSync(configPath, CONFIG_WITH('aws'));
    writeFileSync(join(dataDir, 'sync-etags.json'), '{"stale":true}');
    mkdirSync(join(dataDir, 'aws', 'meta'), { recursive: true });
    writeFileSync(join(dataDir, 'aws', 'meta', 'sync-etags.json'), '{"fresh":true}');

    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(true);
    expect(readFileSync(join(dataDir, 'aws', 'meta', 'sync-etags.json'), 'utf-8')).toBe('{"fresh":true}');
    expect(existsSync(join(dataDir, 'sync-etags.json'))).toBe(false);
  });

  it('skips entirely with no config, no providers, or an unsafe name', () => {
    seedLegacyTree();
    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(false);

    writeFileSync(configPath, 'providers: []\n');
    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(false);

    writeFileSync(configPath, CONFIG_WITH('../escape'));
    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(false);

    expect(existsSync(join(dataDir, 'aws', 'raw', 'daily-2026-01', 'data.parquet'))).toBe(true);
    expect(existsSync(join(dataDir, 'sync-etags.json'))).toBe(true);
  });

  it('accepts a legacy credentials.profile config shape (only name is read)', () => {
    writeFileSync(configPath, `providers:
  - name: aws-main
    type: aws
    credentials:
      profile: p
    sync:
      daily:
        bucket: s3://b/daily
        retentionDays: 30
      intervalMinutes: 60
`);
    seedLegacyTree();
    expect(migrateProviderLayoutSync(dataDir, configPath)).toBe(true);
    expect(existsSync(join(dataDir, 'aws-main', 'raw', 'daily-2026-01', 'data.parquet'))).toBe(true);
  });
});
