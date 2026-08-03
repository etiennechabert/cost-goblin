import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrgAccount, OrgSyncResult } from '@costgoblin/core';
import {
  MERGED_ORG_FILE,
  adoptLegacyMergedFile,
  buildFlatOrgTags,
  clearMergedAndSidecars,
  decodeOrgSyncResult,
  listOrgSidecars,
  mergeOrgResults,
  orgSidecarFileName,
  regenerateMergedOrgFile,
  writeProviderOrgResult,
} from '../main/org-merge.js';

function account(id: string, overrides?: Partial<OrgAccount>): OrgAccount {
  return {
    id,
    name: `acct-${id}`,
    email: `${id}@example.com`,
    status: 'ACTIVE',
    joinedTimestamp: '2024-01-01T00:00:00Z',
    ouPath: '/Root',
    tags: {},
    ...overrides,
  };
}

function syncResult(orgId: string, syncedAt: string, accounts: readonly OrgAccount[]): OrgSyncResult {
  return { accounts, orgId, syncedAt };
}

function readMergedJson(stateDir: string): unknown {
  return JSON.parse(readFileSync(join(stateDir, MERGED_ORG_FILE), 'utf-8'));
}

describe('org-merge', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cg-org-merge-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe('orgSidecarFileName', () => {
    it('builds the sidecar name from a valid provider name', () => {
      expect(orgSidecarFileName('aws-main')).toBe('org-accounts.aws-main.json');
    });

    it('throws on a path-unsafe provider name', () => {
      expect(() => orgSidecarFileName('../evil')).toThrow('Invalid provider name');
      expect(() => orgSidecarFileName('a/b')).toThrow('Invalid provider name');
    });
  });

  describe('listOrgSidecars', () => {
    it('returns sidecars sorted by provider, ignoring the merged file and strangers', () => {
      writeFileSync(join(stateDir, MERGED_ORG_FILE), '{}');
      writeFileSync(join(stateDir, 'org-accounts.zeta.json'), '{}');
      writeFileSync(join(stateDir, 'org-accounts.alpha.json'), '{}');
      writeFileSync(join(stateDir, 'org-account-tags.json'), '[]');
      writeFileSync(join(stateDir, 'region-names.json'), '{}');
      return listOrgSidecars(stateDir).then(sidecars => {
        expect(sidecars).toEqual([
          { providerName: 'alpha', fileName: 'org-accounts.alpha.json' },
          { providerName: 'zeta', fileName: 'org-accounts.zeta.json' },
        ]);
      });
    });

    it('returns [] for a missing directory', async () => {
      expect(await listOrgSidecars(join(stateDir, 'nope'))).toEqual([]);
    });
  });

  describe('mergeOrgResults', () => {
    it('merges two providers, most recently synced winning an id collision', () => {
      const older = syncResult('o-old', '2026-01-01T00:00:00Z', [
        account('111', { name: 'old-name' }),
        account('222'),
      ]);
      const newer = syncResult('o-new', '2026-02-01T00:00:00Z', [
        account('111', { name: 'new-name' }),
        account('333'),
      ]);
      // Input order must not matter — newest syncedAt wins regardless.
      const merged = mergeOrgResults([
        { providerName: 'bbb', result: newer },
        { providerName: 'aaa', result: older },
      ]);

      expect(merged.accounts.map(a => a.id).sort((a, b) => a.localeCompare(b))).toEqual(['111', '222', '333']);
      expect(merged.accounts.find(a => a.id === '111')?.name).toBe('new-name');
      expect(merged.orgId).toBe('o-new');
      expect(merged.syncedAt).toBe('2026-02-01T00:00:00Z');
      expect(merged.providers).toEqual([
        { provider: 'aaa', orgId: 'o-old', syncedAt: '2026-01-01T00:00:00Z' },
        { provider: 'bbb', orgId: 'o-new', syncedAt: '2026-02-01T00:00:00Z' },
      ]);
    });

    it('merges empty input to an empty result', () => {
      expect(mergeOrgResults([])).toEqual({ accounts: [], orgId: '', syncedAt: '', providers: [] });
    });
  });

  describe('writeProviderOrgResult', () => {
    it('writes the sidecar and a merged view that decodes as a legacy OrgSyncResult', async () => {
      const result = syncResult('o-1', '2026-03-01T00:00:00Z', [account('111')]);
      const merged = await writeProviderOrgResult(stateDir, 'aws-main', 'aws-main', result);

      expect(merged.accounts).toEqual(result.accounts);
      const sidecarRaw = readFileSync(join(stateDir, orgSidecarFileName('aws-main')), 'utf-8');
      expect(decodeOrgSyncResult(sidecarRaw)).toEqual(result);
      // Merged file keeps the backward-compatible shape...
      const mergedRaw = readFileSync(join(stateDir, MERGED_ORG_FILE), 'utf-8');
      expect(decodeOrgSyncResult(mergedRaw)).toEqual({ accounts: [account('111')], orgId: 'o-1', syncedAt: '2026-03-01T00:00:00Z' });
      // ...plus the additive per-provider metadata.
      const parsed = readMergedJson(stateDir);
      expect(parsed).toMatchObject({ providers: [{ provider: 'aws-main', orgId: 'o-1', syncedAt: '2026-03-01T00:00:00Z' }] });
    });

    it('merges two providers with an id collision — last-synced provider wins', async () => {
      await writeProviderOrgResult(stateDir, 'aws-main', 'aws-main',
        syncResult('o-main', '2026-01-01T00:00:00Z', [account('111', { name: 'main-view' }), account('222')]));
      const merged = await writeProviderOrgResult(stateDir, 'aws-eu', 'aws-main',
        syncResult('o-eu', '2026-04-01T00:00:00Z', [account('111', { name: 'eu-view' }), account('333')]));

      expect(merged.accounts.map(a => a.id).sort((a, b) => a.localeCompare(b))).toEqual(['111', '222', '333']);
      expect(merged.accounts.find(a => a.id === '111')?.name).toBe('eu-view');
      expect(merged.orgId).toBe('o-eu');
      expect(merged.syncedAt).toBe('2026-04-01T00:00:00Z');
      // Both sidecars persist untouched — re-merging later loses nothing.
      expect(existsSync(join(stateDir, 'org-accounts.aws-main.json'))).toBe(true);
      expect(existsSync(join(stateDir, 'org-accounts.aws-eu.json'))).toBe(true);
      // On-disk merged file matches what was returned.
      expect(readMergedJson(stateDir)).toEqual(merged);
    });

    it('re-syncing the same provider replaces its contribution instead of accumulating', async () => {
      await writeProviderOrgResult(stateDir, 'aws-main', 'aws-main',
        syncResult('o-1', '2026-01-01T00:00:00Z', [account('111'), account('222')]));
      const merged = await writeProviderOrgResult(stateDir, 'aws-main', 'aws-main',
        syncResult('o-1', '2026-05-01T00:00:00Z', [account('111')]));

      expect(merged.accounts.map(a => a.id)).toEqual(['111']);
      expect(merged.providers).toHaveLength(1);
    });
  });

  describe('legacy adoption', () => {
    it('adopts a pre-upgrade merged-only file as the FIRST provider sidecar on first per-provider write', async () => {
      // Pre-#516 install: merged file only, no sidecars.
      const legacy = syncResult('o-legacy', '2025-12-01T00:00:00Z', [account('111', { name: 'legacy-name' }), account('222')]);
      writeFileSync(join(stateDir, MERGED_ORG_FILE), JSON.stringify(legacy, null, 2));

      // First per-provider write comes from a DIFFERENT (second) provider.
      const merged = await writeProviderOrgResult(stateDir, 'aws-eu', 'aws-main',
        syncResult('o-eu', '2026-01-01T00:00:00Z', [account('333')]));

      // The legacy sync was preserved as the first provider's sidecar...
      const adopted = decodeOrgSyncResult(readFileSync(join(stateDir, orgSidecarFileName('aws-main')), 'utf-8'));
      expect(adopted).toEqual(legacy);
      // ...and its accounts survive in the regenerated merged view.
      expect(merged.accounts.map(a => a.id).sort((a, b) => a.localeCompare(b))).toEqual(['111', '222', '333']);
      expect(merged.providers.map(p => p.provider)).toEqual(['aws-main', 'aws-eu']);
      expect(merged.orgId).toBe('o-eu');
    });

    it('does not adopt when a sidecar already exists', async () => {
      writeFileSync(join(stateDir, MERGED_ORG_FILE), JSON.stringify(syncResult('o-x', '2025-01-01T00:00:00Z', [account('999')])));
      writeFileSync(join(stateDir, 'org-accounts.aws-eu.json'), JSON.stringify(syncResult('o-eu', '2026-01-01T00:00:00Z', [account('333')])));

      expect(await adoptLegacyMergedFile(stateDir, 'aws-main')).toBe(false);
      expect(existsSync(join(stateDir, 'org-accounts.aws-main.json'))).toBe(false);
    });

    it('does not adopt a missing or undecodable merged file', async () => {
      expect(await adoptLegacyMergedFile(stateDir, 'aws-main')).toBe(false);
      writeFileSync(join(stateDir, MERGED_ORG_FILE), 'not json');
      expect(await adoptLegacyMergedFile(stateDir, 'aws-main')).toBe(false);
      expect(existsSync(join(stateDir, 'org-accounts.aws-main.json'))).toBe(false);
    });
  });

  describe('regenerateMergedOrgFile', () => {
    it('returns null and leaves the merged file alone when no sidecar decodes', async () => {
      writeFileSync(join(stateDir, MERGED_ORG_FILE), '{"keep":"me"}');
      writeFileSync(join(stateDir, 'org-accounts.aws-main.json'), 'broken');

      expect(await regenerateMergedOrgFile(stateDir)).toBeNull();
      expect(readFileSync(join(stateDir, MERGED_ORG_FILE), 'utf-8')).toBe('{"keep":"me"}');
    });

    it('skips an undecodable sidecar but merges the healthy ones', async () => {
      writeFileSync(join(stateDir, 'org-accounts.aws-bad.json'), 'broken');
      writeFileSync(join(stateDir, 'org-accounts.aws-main.json'),
        JSON.stringify(syncResult('o-1', '2026-01-01T00:00:00Z', [account('111')])));

      const merged = await regenerateMergedOrgFile(stateDir);
      expect(merged?.accounts.map(a => a.id)).toEqual(['111']);
      expect(merged?.providers.map(p => p.provider)).toEqual(['aws-main']);
    });
  });

  describe('clearMergedAndSidecars', () => {
    it('deletes the merged file and every sidecar, reporting what it removed', async () => {
      writeFileSync(join(stateDir, MERGED_ORG_FILE), '{}');
      writeFileSync(join(stateDir, 'org-accounts.aws-main.json'), '{}');
      writeFileSync(join(stateDir, 'org-accounts.aws-eu.json'), '{}');
      // Non-org files must survive the clear.
      writeFileSync(join(stateDir, 'region-names.json'), '{}');

      const result = await clearMergedAndSidecars(stateDir);

      expect([...result.deleted].sort((a, b) => a.localeCompare(b))).toEqual([
        'org-accounts.aws-eu.json',
        'org-accounts.aws-main.json',
        'org-accounts.json',
      ]);
      expect(result.failed).toEqual([]);
      expect(existsSync(join(stateDir, MERGED_ORG_FILE))).toBe(false);
      expect(existsSync(join(stateDir, 'org-accounts.aws-main.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'org-accounts.aws-eu.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'region-names.json'))).toBe(true);
    });

    it('is idempotent — a second clear deletes nothing and fails nothing', async () => {
      writeFileSync(join(stateDir, MERGED_ORG_FILE), '{}');
      await clearMergedAndSidecars(stateDir);
      const second = await clearMergedAndSidecars(stateDir);
      expect(second.deleted).toEqual([]);
      expect(second.failed).toEqual([]);
    });
  });

  describe('buildFlatOrgTags', () => {
    it('projects id/tags/ouPath per account (the shape getOrgAccountsPath probes for)', () => {
      const accounts = [
        account('111', { tags: { Team: 'core' }, ouPath: '/Root/Prod' }),
        account('222'),
      ];
      expect(JSON.parse(buildFlatOrgTags(accounts))).toEqual([
        { id: '111', tags: { Team: 'core' }, ouPath: '/Root/Prod' },
        { id: '222', tags: {}, ouPath: '/Root' },
      ]);
    });
  });
});
