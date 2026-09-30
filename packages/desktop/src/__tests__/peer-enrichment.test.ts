import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { sqlStringLiteral } from '@costgoblin/core';
import type { OrgAccount, PackEnrichment } from '@costgoblin/core';
import {
  applyPulledEnrichment,
  decodePeerOrgAccounts,
  decodeRegionNames,
  enrichmentConsent,
  summarizePeerEnrichment,
} from '../main/peer-enrichment.js';
import { buildFlatOrgTags } from '../main/org-merge.js';
import { fetchRows } from './helpers/duckdb-rows.js';

/** Peer-shared enrichment (#605): account/region names ride along a LAN pull.
 *  They are untrusted input from a teammate's machine, so they must be gated
 *  on the consumer's consent and strictly decoded before touching disk. */

const ORG_FILE = 'org-accounts.json';
const FLAT_FILE = 'org-account-tags.json';
const REGION_FILE = 'region-names.json';

function account(id: string, overrides?: Partial<OrgAccount>): OrgAccount {
  return {
    id,
    name: `acct-${id}`,
    email: `${id}@example.com`,
    status: 'ACTIVE',
    joinedTimestamp: '2024-01-01T00:00:00Z',
    ouPath: '/Root/Eng',
    tags: { team: `team-${id}` },
    ...overrides,
  };
}

function orgPayload(accounts: readonly unknown[], extra?: Record<string, unknown>): string {
  return JSON.stringify({ accounts, orgId: 'o-peer', syncedAt: '2026-09-01T00:00:00Z', ...extra });
}

const SSM_REGIONS = {
  syncedAt: '2026-09-01T00:00:00Z',
  regions: {
    'eu-central-1': { longName: 'Europe (Frankfurt)', country: 'DE', continent: 'EU' },
    'us-east-1': { longName: 'US East (N. Virginia)', country: 'US', continent: 'NA' },
    // SSM leaves country/continent empty for some regions; still valid.
    'us-gov-west-1': { longName: 'AWS GovCloud (US-West)', country: '', continent: '' },
  },
};

function regionPayload(regions: Record<string, unknown>, syncedAt = '2026-09-01T00:00:00Z'): string {
  return JSON.stringify({ syncedAt, regions });
}

function enrichment(overrides?: Partial<PackEnrichment>): PackEnrichment {
  return { orgAccounts: null, regionNames: null, orgAccountTags: null, ...overrides };
}

describe('enrichmentConsent', () => {
  it('consents when no selection was made (pull everything, the legacy default)', () => {
    expect(enrichmentConsent(undefined)).toBe(true);
    expect(enrichmentConsent()).toBe(true);
  });

  it('withholds consent when the selection leaves out config', () => {
    expect(enrichmentConsent({ sources: ['daily'] })).toBe(false);
    expect(enrichmentConsent({ sources: ['daily', 'hourly', 'cost-optimization'], periods: ['2026-06'] })).toBe(false);
    expect(enrichmentConsent({ sources: [] })).toBe(false);
  });

  it('consents when the selection includes config', () => {
    expect(enrichmentConsent({ sources: ['config', 'daily'] })).toBe(true);
    expect(enrichmentConsent({ sources: ['config'] })).toBe(true);
  });
});

describe('decodePeerOrgAccounts', () => {
  it('accepts a valid payload and canonicalises it to the known fields only', () => {
    const extra = { ...account('111111111111'), injected: 'x' };
    const result = decodePeerOrgAccounts(orgPayload([extra, account('222222222222')], { providers: [{ provider: 'p' }] }));
    expect(result).toEqual({
      ok: true,
      value: { accounts: [account('111111111111'), account('222222222222')], orgId: 'o-peer', syncedAt: '2026-09-01T00:00:00Z' },
    });
  });

  it('accepts ids with the AWS/GCP charset (digits, letters, . _ : -)', () => {
    const result = decodePeerOrgAccounts(orgPayload([account('my-project_1.a:b')]));
    expect(result.ok).toBe(true);
  });

  it('rejects non-JSON and non-org shapes', () => {
    expect(decodePeerOrgAccounts('not json').ok).toBe(false);
    expect(decodePeerOrgAccounts('[]').ok).toBe(false);
    expect(decodePeerOrgAccounts(JSON.stringify({ accounts: 'x', orgId: 'o', syncedAt: 's' })).ok).toBe(false);
  });

  it('rejects an empty account list with reason "empty"', () => {
    expect(decodePeerOrgAccounts(orgPayload([]))).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects more than 50 000 accounts', () => {
    const many = Array.from({ length: 50_001 }, (_, i) => account(String(i)));
    expect(decodePeerOrgAccounts(orgPayload(many)).ok).toBe(false);
    // …but the cap itself is allowed.
    expect(decodePeerOrgAccounts(orgPayload(many.slice(0, 50_000))).ok).toBe(true);
  });

  it.each([
    ['an id with a space', account('1234 5678')],
    ['an empty id', account('')],
    ['an id over 128 chars', account('a'.repeat(129))],
    ['a non-string tag value', { ...account('1'), tags: { team: 42 } }],
    ['a NUL in a name', account('1', { name: 'evil\u0000name' })],
    ['a control char in an ouPath', account('1', { ouPath: '/Root/\u001bEng' })],
    ['a DEL in a tag value', account('1', { tags: { team: 'a\u007fb' } })],
    ['a control char in a tag key', account('1', { tags: { 'te\nam': 'a' } })],
    ['a name over 256 chars', account('1', { name: 'n'.repeat(257) })],
    ['an email over 256 chars', account('1', { email: 'e'.repeat(257) })],
    ['a status over 256 chars', account('1', { status: 's'.repeat(257) })],
    ['a joinedTimestamp over 256 chars', account('1', { joinedTimestamp: 't'.repeat(257) })],
    ['an ouPath over 1024 chars', account('1', { ouPath: 'o'.repeat(1025) })],
    ['more than 200 tags', account('1', { tags: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${String(i)}`, 'v'])) })],
    ['a tag key over 128 chars', account('1', { tags: { ['k'.repeat(129)]: 'v' } })],
    ['a tag value over 256 chars', account('1', { tags: { team: 'v'.repeat(257) } })],
  ])('rejects the whole payload for %s', (_label, bad) => {
    const result = decodePeerOrgAccounts(orgPayload([account('999'), bad]));
    expect(result.ok).toBe(false);
  });

  it('rejects an account missing joinedTimestamp', () => {
    const noJoined = Object.fromEntries(Object.entries(account('1')).filter(([key]) => key !== 'joinedTimestamp'));
    expect(noJoined).not.toHaveProperty('joinedTimestamp');
    expect(decodePeerOrgAccounts(orgPayload([noJoined])).ok).toBe(false);
  });

  it('accepts fields exactly at their caps', () => {
    const atCaps = account('a'.repeat(128), {
      name: 'n'.repeat(256),
      email: 'e'.repeat(256),
      status: 's'.repeat(256),
      joinedTimestamp: 't'.repeat(256),
      ouPath: 'o'.repeat(1024),
      tags: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${'k'.repeat(120)}${String(i)}`, 'v'.repeat(256)])),
    });
    expect(decodePeerOrgAccounts(orgPayload([atCaps], { orgId: 'o'.repeat(128), syncedAt: 's'.repeat(128) })).ok).toBe(true);
  });

  // The flat tags file derived from these accounts is LEFT JOINed onto every
  // cost row by id, so a repeated id would repeat that account's costs.
  it('rejects a payload that repeats an account id', () => {
    const result = decodePeerOrgAccounts(orgPayload([account('111122223333'), account('222222222222'), account('111122223333')]));
    expect(result).toEqual({ ok: false, reason: 'duplicate account id 111122223333' });
  });

  // DuckDB's read_json refuses an unpaired surrogate in the flat tags file,
  // which would fail every query that joins it.
  it.each([
    ['a tag value', { tags: { team: 'x\ud800y' } }],
    ['a tag key', { tags: { 'k\udc00': 'v' } }],
    ['the ouPath', { ouPath: 'Root/\ud83d' }],
    ['the name', { name: 'Acme \udfff' }],
  ])('rejects an unpaired surrogate in %s', (_label, overrides) => {
    expect(decodePeerOrgAccounts(orgPayload([account('333333333333', overrides)])).ok).toBe(false);
  });

  it('accepts a correctly paired surrogate (an emoji) in a tag value', () => {
    expect(decodePeerOrgAccounts(orgPayload([account('333333333333', { tags: { team: 'infra \ud83d\ude80' } })])).ok).toBe(true);
  });

  it('rejects an orgId or syncedAt over 128 chars, or with a control char', () => {
    expect(decodePeerOrgAccounts(orgPayload([account('1')], { orgId: 'o'.repeat(129) })).ok).toBe(false);
    expect(decodePeerOrgAccounts(orgPayload([account('1')], { syncedAt: 's'.repeat(129) })).ok).toBe(false);
    expect(decodePeerOrgAccounts(orgPayload([account('1')], { orgId: 'o-\u0000' })).ok).toBe(false);
  });
});

describe('decodeRegionNames', () => {
  it('accepts an SSM-shaped map and canonicalises it', () => {
    const withExtra = {
      ...SSM_REGIONS,
      injected: true,
      regions: { ...SSM_REGIONS.regions, 'eu-west-1': { longName: 'Europe (Ireland)', country: 'IE', continent: 'EU', extra: 1 } },
    };
    const result = decodeRegionNames(JSON.stringify(withExtra));
    expect(result).toEqual({
      ok: true,
      value: {
        syncedAt: '2026-09-01T00:00:00Z',
        regions: { ...SSM_REGIONS.regions, 'eu-west-1': { longName: 'Europe (Ireland)', country: 'IE', continent: 'EU' } },
      },
    });
  });

  it('rejects non-JSON and non-region shapes', () => {
    expect(decodeRegionNames('nope').ok).toBe(false);
    expect(decodeRegionNames('[]').ok).toBe(false);
    expect(decodeRegionNames(JSON.stringify({ syncedAt: 's' })).ok).toBe(false);
    expect(decodeRegionNames(JSON.stringify({ regions: SSM_REGIONS.regions })).ok).toBe(false);
  });

  it.each([
    ['a NUL in a region code', { 'eu-central-1\u0000x': { longName: 'x', country: '', continent: '' } }],
    ['a NUL in a label', { 'eu-central-1': { longName: 'Europe\u0000(Frankfurt)', country: 'DE', continent: 'EU' } }],
    ['a control char in a country', { 'eu-central-1': { longName: 'Europe', country: 'D\nE', continent: 'EU' } }],
    ['an uppercase code', { 'EU-CENTRAL-1': { longName: 'Europe', country: 'DE', continent: 'EU' } }],
    ['a code with a space', { 'eu central-1': { longName: 'Europe', country: 'DE', continent: 'EU' } }],
    ['a code over 40 chars', { ['a'.repeat(41)]: { longName: 'Europe', country: 'DE', continent: 'EU' } }],
    ['an empty longName', { 'eu-central-1': { longName: '', country: 'DE', continent: 'EU' } }],
    ['a longName over 128 chars', { 'eu-central-1': { longName: 'L'.repeat(129), country: 'DE', continent: 'EU' } }],
    ['a continent over 128 chars', { 'eu-central-1': { longName: 'Europe', country: 'DE', continent: 'C'.repeat(129) } }],
    ['a missing country', { 'eu-central-1': { longName: 'Europe', continent: 'EU' } }],
    ['a non-string continent', { 'eu-central-1': { longName: 'Europe', country: 'DE', continent: 7 } }],
    ['a non-object entry', { 'eu-central-1': 'Europe' }],
    ['no entries', {}],
  ])('rejects %s', (_label, regions) => {
    expect(decodeRegionNames(regionPayload(regions)).ok).toBe(false);
  });

  it('rejects more than 500 entries but accepts exactly 500', () => {
    const make = (n: number): Record<string, unknown> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`r-${String(i)}`, { longName: `Region ${String(i)}`, country: '', continent: '' }]));
    expect(decodeRegionNames(regionPayload(make(501))).ok).toBe(false);
    expect(decodeRegionNames(regionPayload(make(500))).ok).toBe(true);
  });

  it('rejects a syncedAt over 128 chars or with a control char', () => {
    expect(decodeRegionNames(regionPayload(SSM_REGIONS.regions, 's'.repeat(129))).ok).toBe(false);
    expect(decodeRegionNames(regionPayload(SSM_REGIONS.regions, '2026\u0000')).ok).toBe(false);
  });
});

describe('summarizePeerEnrichment', () => {
  const orgs = orgPayload([account('1'), account('2')]);
  const regions = JSON.stringify(SSM_REGIONS);

  it('counts what the strict decoders would write', () => {
    expect(summarizePeerEnrichment(enrichment({ orgAccounts: orgs, regionNames: regions }))).toEqual({ accounts: 2, regions: 3 });
  });

  it('counts 0 for a part that is missing or fails to decode', () => {
    expect(summarizePeerEnrichment(enrichment({ orgAccounts: orgs }))).toEqual({ accounts: 2, regions: 0 });
    expect(summarizePeerEnrichment(enrichment({ orgAccounts: orgPayload([]), regionNames: regions }))).toEqual({ accounts: 0, regions: 3 });
    expect(summarizePeerEnrichment(enrichment({ orgAccounts: orgs, regionNames: '\u0000' }))).toEqual({ accounts: 2, regions: 0 });
  });

  it('is null when neither part would be written', () => {
    expect(summarizePeerEnrichment(enrichment())).toBeNull();
    expect(summarizePeerEnrichment(enrichment({ orgAccounts: 'x', regionNames: 'y', orgAccountTags: '[{"id":"1"}]' }))).toBeNull();
  });
});

describe('applyPulledEnrichment', () => {
  let stateDir: string;
  const LOCAL_ORG = '{"accounts":[{"local":true}],"orgId":"o-local","syncedAt":"x"}\n';
  const LOCAL_FLAT = '[{"id":"local","tags":{},"ouPath":"/Local"}]';
  const LOCAL_REGIONS = '{"syncedAt":"local","regions":{}}  ';

  function seedLocal(): void {
    writeFileSync(join(stateDir, ORG_FILE), LOCAL_ORG);
    writeFileSync(join(stateDir, FLAT_FILE), LOCAL_FLAT);
    writeFileSync(join(stateDir, REGION_FILE), LOCAL_REGIONS);
  }

  function expectLocalUntouched(): void {
    expect(readFileSync(join(stateDir, ORG_FILE), 'utf-8')).toBe(LOCAL_ORG);
    expect(readFileSync(join(stateDir, FLAT_FILE), 'utf-8')).toBe(LOCAL_FLAT);
    expect(readFileSync(join(stateDir, REGION_FILE), 'utf-8')).toBe(LOCAL_REGIONS);
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'cg-peer-enrichment-'));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('leaves local files byte-identical when the peer sends nothing', async () => {
    seedLocal();
    const report = await applyPulledEnrichment(stateDir, enrichment());
    expectLocalUntouched();
    expect(report).toEqual([
      { file: ORG_FILE, status: 'skipped' },
      { file: FLAT_FILE, status: 'skipped' },
      { file: REGION_FILE, status: 'skipped' },
    ]);
  });

  it('leaves local files byte-identical when the peer sends garbage', async () => {
    seedLocal();
    const report = await applyPulledEnrichment(stateDir, enrichment({
      orgAccounts: 'not json {',
      regionNames: '\u0000',
      orgAccountTags: '[]',
    }));
    expectLocalUntouched();
    expect(report.map(r => r.status)).toEqual(['rejected', 'skipped', 'rejected']);
  });

  it('leaves local files byte-identical when fields fail the strict decode', async () => {
    seedLocal();
    const report = await applyPulledEnrichment(stateDir, enrichment({
      orgAccounts: orgPayload([account('1', { name: 'bad\u0000' })]),
      regionNames: regionPayload({ 'eu-central-1\u0000x': { longName: 'x', country: '', continent: '' } }),
    }));
    expectLocalUntouched();
    const rejected = report.flatMap(r => (r.status === 'rejected' ? [r] : []));
    expect(rejected.map(r => r.file)).toEqual([ORG_FILE, REGION_FILE]);
    for (const r of rejected) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('writes nothing for an empty account list', async () => {
    seedLocal();
    const report = await applyPulledEnrichment(stateDir, enrichment({ orgAccounts: orgPayload([]) }));
    expectLocalUntouched();
    expect(report[0]).toEqual({ file: ORG_FILE, status: 'rejected', reason: 'empty' });
  });

  it('never creates files for rejected input on a fresh install', async () => {
    const fresh = join(stateDir, 'fresh');
    await applyPulledEnrichment(fresh, enrichment({ orgAccounts: orgPayload([]), regionNames: 'x', orgAccountTags: '[]' }));
    expect(existsSync(join(fresh, ORG_FILE))).toBe(false);
    expect(existsSync(join(fresh, FLAT_FILE))).toBe(false);
    expect(existsSync(join(fresh, REGION_FILE))).toBe(false);
  });

  it.each([
    ['garbage', 'this is not json'],
    ['an ouPath-only row with no tags', '[{"id":"1","ouPath":"a"}]'],
    ['an empty array', '[]'],
  ])('writes canonical org accounts and DERIVES the flat file, ignoring a peer orgAccountTags of %s', async (_label, peerFlat) => {
    seedLocal();
    const accounts = [{ ...account('111'), injected: 'x' }, account('222', { tags: {} })];
    const report = await applyPulledEnrichment(stateDir, enrichment({ orgAccounts: orgPayload(accounts), orgAccountTags: peerFlat }));

    const canonical = { accounts: [account('111'), account('222', { tags: {} })], orgId: 'o-peer', syncedAt: '2026-09-01T00:00:00Z' };
    expect(readFileSync(join(stateDir, ORG_FILE), 'utf-8')).toBe(JSON.stringify(canonical, null, 2));
    expect(readFileSync(join(stateDir, FLAT_FILE), 'utf-8')).toBe(buildFlatOrgTags(canonical.accounts));
    // Region file was not offered, so it is untouched.
    expect(readFileSync(join(stateDir, REGION_FILE), 'utf-8')).toBe(LOCAL_REGIONS);
    expect(report).toEqual([
      { file: ORG_FILE, status: 'written' },
      { file: FLAT_FILE, status: 'written' },
      { file: REGION_FILE, status: 'skipped' },
    ]);
  });

  it('writes canonical region names', async () => {
    seedLocal();
    const report = await applyPulledEnrichment(stateDir, enrichment({ regionNames: JSON.stringify({ ...SSM_REGIONS, extra: 1 }) }));
    expect(readFileSync(join(stateDir, REGION_FILE), 'utf-8')).toBe(JSON.stringify(SSM_REGIONS, null, 2));
    expect(readFileSync(join(stateDir, ORG_FILE), 'utf-8')).toBe(LOCAL_ORG);
    expect(report[2]).toEqual({ file: REGION_FILE, status: 'written' });
  });

  it('creates the state dir on a fresh install', async () => {
    const fresh = join(stateDir, 'nested', 'fresh');
    await applyPulledEnrichment(fresh, enrichment({ orgAccounts: orgPayload([account('1')]), regionNames: JSON.stringify(SSM_REGIONS) }));
    expect(existsSync(join(fresh, ORG_FILE))).toBe(true);
    expect(existsSync(join(fresh, FLAT_FILE))).toBe(true);
    expect(existsSync(join(fresh, REGION_FILE))).toBe(true);
  });

  describe('the derived flat file binds in DuckDB', () => {
    /** The org-tags join projection from core's buildFromClause (builder.ts):
     *  an explicit-schema read_json plus the tag / ouPath fallback selects. */
    async function project(flatPath: string): Promise<readonly Record<string, unknown>[]> {
      const db = await DuckDBInstance.create();
      const conn = await db.connect();
      try {
        return await fetchRows(conn, `
          SELECT id, tags->>'team' AS fallback_team, ouPath AS fallback_ou
          FROM read_json(${sqlStringLiteral(flatPath)}, format='array', columns={id: 'VARCHAR', tags: 'JSON', ouPath: 'VARCHAR'})
          ORDER BY id`);
      } finally {
        conn.disconnectSync();
        db.closeSync();
      }
    }

    it('resolves tag and ouPath fallbacks', async () => {
      await applyPulledEnrichment(stateDir, enrichment({
        orgAccounts: orgPayload([account('111'), account('222', { tags: {}, ouPath: '/Root/Data' })]),
        orgAccountTags: '[]',
      }));
      const rows = await project(join(stateDir, FLAT_FILE));
      expect(rows).toEqual([
        { id: '111', fallback_team: 'team-111', fallback_ou: '/Root/Eng' },
        { id: '222', fallback_team: null, fallback_ou: '/Root/Data' },
      ]);
    });

    it('binds even when every account has empty tags', async () => {
      await applyPulledEnrichment(stateDir, enrichment({
        orgAccounts: orgPayload([account('111', { tags: {} }), account('222', { tags: {} })]),
      }));
      const rows = await project(join(stateDir, FLAT_FILE));
      expect(rows).toEqual([
        { id: '111', fallback_team: null, fallback_ou: '/Root/Eng' },
        { id: '222', fallback_team: null, fallback_ou: '/Root/Eng' },
      ]);
    });
  });
});
