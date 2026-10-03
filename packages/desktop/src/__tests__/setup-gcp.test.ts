import { describe, it, expect } from 'vitest';
import { isGcpCredentialError } from '@costgoblin/core';
import type { GcsPrefixPage } from '../main/setup-gcp.js';
import { collectGcsPrefixes, extractGcsPrefixNames, gcsNextPageToken, listGcsBucketsAs, parseGcloudProjects, parseWizardReader, wizardGcsErrorMessage, wizardWriteReader } from '../main/setup-gcp.js';

describe('parseGcloudProjects', () => {
  it('reads the shape `gcloud projects list --format=json` emits', () => {
    const stdout = JSON.stringify([
      { projectId: 'acme-prod', name: 'Acme Production', lifecycleState: 'ACTIVE' },
      { projectId: 'acme-dev', name: 'Acme Dev', lifecycleState: 'ACTIVE' },
    ]);
    expect(parseGcloudProjects(stdout)).toEqual([
      { projectId: 'acme-prod', name: 'Acme Production' },
      { projectId: 'acme-dev', name: 'Acme Dev' },
    ]);
  });

  it('falls back to the id when a project has no display name', () => {
    const stdout = JSON.stringify([{ projectId: 'nameless' }]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'nameless', name: 'nameless' }]);
  });

  it('drops projects that are not ACTIVE', () => {
    // A DELETE_REQUESTED project still lists, but its buckets are already
    // going away — offering it sends the user down a dead end.
    const stdout = JSON.stringify([
      { projectId: 'live', name: 'Live', lifecycleState: 'ACTIVE' },
      { projectId: 'doomed', name: 'Doomed', lifecycleState: 'DELETE_REQUESTED' },
    ]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'live', name: 'Live' }]);
  });

  it('keeps a project whose lifecycleState the CLI omitted', () => {
    // Absent is not the same as non-ACTIVE; older CLI versions and some
    // --format filters drop the field entirely.
    const stdout = JSON.stringify([{ projectId: 'p', name: 'P' }]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'p', name: 'P' }]);
  });

  it('skips entries with no usable projectId rather than inventing one', () => {
    const stdout = JSON.stringify([{ name: 'No Id' }, { projectId: '', name: 'Blank' }, { projectId: 'ok' }]);
    expect(parseGcloudProjects(stdout)).toEqual([{ projectId: 'ok', name: 'ok' }]);
  });

  it('returns empty for the CLI s empty listing', () => {
    expect(parseGcloudProjects('[]')).toEqual([]);
  });

  it('reports unreadable stdout as null, distinct from an empty list', () => {
    // gcloud prints update nags and auth prompts to stdout in some configs
    // while still exiting 0. Collapsing that into [] made the wizard claim
    // "No Google Cloud projects found" — a statement about the user's account
    // rather than about our failure to read it.
    expect(parseGcloudProjects('You do not currently have an active account')).toBeNull();
    expect(parseGcloudProjects('')).toBeNull();
  });

  it('reports a JSON object rather than an array as unreadable', () => {
    expect(parseGcloudProjects('{"projectId":"x"}')).toBeNull();
  });

  it('still returns an empty array for a genuinely empty list', () => {
    expect(parseGcloudProjects('[]')).toEqual([]);
  });
});

describe('extractGcsPrefixNames', () => {
  it('returns child folder names relative to the browsed prefix', () => {
    const apiResponse = { prefixes: ['focus/daily/', 'focus/hourly/'] };
    expect(extractGcsPrefixNames(apiResponse, 'focus/')).toEqual(['daily', 'hourly']);
  });

  it('handles the bucket root, where the prefix is empty', () => {
    const apiResponse = { prefixes: ['focus/', 'logs/'] };
    expect(extractGcsPrefixNames(apiResponse, '')).toEqual(['focus', 'logs']);
  });

  it('returns empty when the response carries no prefixes key', () => {
    // A folder holding only objects (no subfolders) omits `prefixes` entirely.
    expect(extractGcsPrefixNames({ items: [] }, 'focus/')).toEqual([]);
  });

  it('returns empty for a response that is not an object', () => {
    expect(extractGcsPrefixNames(undefined, '')).toEqual([]);
    expect(extractGcsPrefixNames(null, '')).toEqual([]);
    expect(extractGcsPrefixNames('nope', '')).toEqual([]);
  });

  it('ignores non-string entries inside prefixes', () => {
    expect(extractGcsPrefixNames({ prefixes: ['a/', 42, null] }, '')).toEqual(['a']);
  });

  it('drops a prefix that does not sit under the browsed one', () => {
    // Defensive: slicing by length would otherwise mangle the name into a
    // folder the user can click but that resolves nowhere.
    expect(extractGcsPrefixNames({ prefixes: ['other/thing/'] }, 'focus/')).toEqual([]);
  });

  it('drops the self-referential prefix rather than emitting an empty name', () => {
    expect(extractGcsPrefixNames({ prefixes: ['focus/'] }, 'focus/')).toEqual([]);
  });
});

describe('gcsNextPageToken', () => {
  it('reads a string pageToken', () => {
    expect(gcsNextPageToken({ pageToken: 'abc' })).toBe('abc');
  });

  it('returns undefined for missing, non-object, or oddly-typed nextQuery', () => {
    // An SDK upgrade that changes nextQuery's shape must terminate the walk,
    // not loop forever or throw.
    expect(gcsNextPageToken(undefined)).toBeUndefined();
    expect(gcsNextPageToken(null)).toBeUndefined();
    expect(gcsNextPageToken({})).toBeUndefined();
    expect(gcsNextPageToken({ pageToken: 42 })).toBeUndefined();
    expect(gcsNextPageToken('abc')).toBeUndefined();
  });
});

describe('collectGcsPrefixes', () => {
  /** Build a fetchPage that serves the given pages in order, keyed by the token
   *  each page hands to the next. Records how many pages were requested. */
  function pager(pages: readonly { prefixes: unknown[]; nextPageToken: string | undefined }[]): {
    fetchPage: () => Promise<GcsPrefixPage>;
    calls: () => number;
  } {
    let i = 0;
    return {
      calls: () => i,
      // Serves pages in order (the token walk is exercised by collectGcsPrefixes
      // driving this repeatedly), so the token argument is unused here.
      fetchPage: (): Promise<GcsPrefixPage> => {
        const page = pages[i];
        i += 1;
        if (page === undefined) throw new Error('fetchPage called more times than there are pages');
        return Promise.resolve({ apiResponse: { prefixes: page.prefixes }, nextPageToken: page.nextPageToken });
      },
    };
  }

  it('walks every page via its token and returns all folders', async () => {
    const { fetchPage, calls } = pager([
      { prefixes: ['focus/a/'], nextPageToken: 't1' },
      { prefixes: ['focus/b/'], nextPageToken: 't2' },
      { prefixes: ['focus/c/'], nextPageToken: undefined },
    ]);
    const result = await collectGcsPrefixes('focus/', 12, fetchPage);
    expect(result).toEqual({ prefixes: ['a', 'b', 'c'], truncated: false });
    expect(calls()).toBe(3);
  });

  it('dedupes folder names that repeat across pages', async () => {
    const { fetchPage } = pager([
      { prefixes: ['focus/daily/', 'focus/hourly/'], nextPageToken: 't1' },
      { prefixes: ['focus/hourly/', 'focus/monthly/'], nextPageToken: undefined },
    ]);
    const result = await collectGcsPrefixes('focus/', 12, fetchPage);
    expect(result).toEqual({ prefixes: ['daily', 'hourly', 'monthly'], truncated: false });
  });

  it('stops at maxPages with a token still pending and reports truncated', async () => {
    const { fetchPage, calls } = pager([
      { prefixes: ['focus/a/'], nextPageToken: 't1' },
      { prefixes: ['focus/b/'], nextPageToken: 't2' }, // token still pending at the cap
      { prefixes: ['focus/c/'], nextPageToken: 't3' },
    ]);
    const result = await collectGcsPrefixes('focus/', 2, fetchPage);
    expect(result).toEqual({ prefixes: ['a', 'b'], truncated: true });
    expect(calls()).toBe(2); // never fetched the third page
  });

  it('does not report truncated when the last page fills the cap but has no token', async () => {
    const { fetchPage } = pager([
      { prefixes: ['focus/a/'], nextPageToken: 't1' },
      { prefixes: ['focus/b/'], nextPageToken: undefined }, // exactly maxPages, done
    ]);
    const result = await collectGcsPrefixes('focus/', 2, fetchPage);
    expect(result).toEqual({ prefixes: ['a', 'b'], truncated: false });
  });

  it('terminates with what it has when a page returns an odd apiResponse', async () => {
    const { fetchPage } = pager([
      { prefixes: ['focus/a/'], nextPageToken: 't1' },
      // extractGcsPrefixNames tolerates a bad shape → contributes nothing.
      { prefixes: [42, null], nextPageToken: undefined },
    ]);
    const result = await collectGcsPrefixes('focus/', 12, fetchPage);
    expect(result).toEqual({ prefixes: ['a'], truncated: false });
  });
});

describe('parseWizardReader', () => {
  it('treats an absent or blank reader as "browse as the ADC login"', () => {
    expect(parseWizardReader(undefined)).toEqual({ ok: true, reader: undefined });
    expect(parseWizardReader('')).toEqual({ ok: true, reader: undefined });
    expect(parseWizardReader('   ')).toEqual({ ok: true, reader: undefined });
  });

  it('accepts a service-account address, trimmed', () => {
    expect(parseWizardReader(' reader@proj.iam.gserviceaccount.com ')).toEqual({ ok: true, reader: 'reader@proj.iam.gserviceaccount.com' });
  });

  it('rejects anything else crossing the IPC boundary, before any SDK call', () => {
    for (const bad of [42, {}, 'someone@gmail.com', '--impersonate-service-account=x', 'Reader@proj.iam.gserviceaccount.com']) {
      const result = parseWizardReader(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/service-account address/);
    }
  });
});

describe('wizardGcsErrorMessage', () => {
  it('rewrites an impersonation denial into the Token Creator remedy, naming the reader', () => {
    // Verbatim runtime shape: google-auth-library prefixes the IAM 403 with
    // the same `Could not refresh access token` an expired login carries.
    const raw = "Could not refresh access token: PERMISSION_DENIED: unable to impersonate: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).";
    const message = wizardGcsErrorMessage(new Error(raw), 'reader@proj.iam.gserviceaccount.com');
    expect(message).toContain('roles/iam.serviceAccountTokenCreator');
    expect(message).toContain('reader@proj.iam.gserviceaccount.com');
    // The wizard offers a sign-in button on this predicate; signing in cannot
    // grant a role, so it must not fire.
    expect(isGcpCredentialError(new Error(message))).toBe(false);
  });

  it('passes every other failure through verbatim, so sign-in and bucket-list classification still see it', () => {
    expect(wizardGcsErrorMessage(new Error('Could not load the default credentials.'), undefined)).toBe('Could not load the default credentials.');
    expect(wizardGcsErrorMessage('plain string', undefined)).toBe('plain string');
  });
});

describe('listGcsBucketsAs', () => {
  const READER = 'reader@proj.iam.gserviceaccount.com';

  it('lists the project as the named reader, through the injected client builder', async () => {
    const built: unknown[] = [];
    const result = await listGcsBucketsAs('billing-proj', ` ${READER} `, (options) => {
      built.push(options);
      return Promise.resolve({ getBuckets: () => Promise.resolve([[{ name: 'export-a' }, { name: 'export-b' }]]) });
    });
    expect(built).toEqual([{ projectId: 'billing-proj', impersonateServiceAccount: READER }]);
    expect(result).toEqual({ buckets: [{ name: 'export-a' }, { name: 'export-b' }] });
  });

  it('refuses a malformed reader before building any client', async () => {
    let builds = 0;
    const result = await listGcsBucketsAs('billing-proj', 'someone@gmail.com', () => {
      builds += 1;
      return Promise.resolve({ getBuckets: () => Promise.resolve([[]]) });
    });
    expect(builds).toBe(0);
    expect(result.buckets).toEqual([]);
    expect(result.error).toMatch(/service-account address/);
  });

  it('carries a listing failure back as text, rewriting an impersonation refusal into its remedy', async () => {
    const denied = "Could not refresh access token: PERMISSION_DENIED: unable to impersonate: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).";
    const result = await listGcsBucketsAs('billing-proj', READER, () => Promise.resolve({
      getBuckets: () => Promise.reject(new Error(denied)),
    }));
    expect(result.buckets).toEqual([]);
    expect(result.error).toContain('roles/iam.serviceAccountTokenCreator');
  });
});

describe('wizardWriteReader', () => {
  it('keeps "absent" distinct from "blank" so the upsert can carry versus clear', () => {
    expect(wizardWriteReader(undefined)).toBeUndefined();
    expect(wizardWriteReader('')).toBe('');
    expect(wizardWriteReader('   ')).toBe('');
    expect(wizardWriteReader(' reader@proj.iam.gserviceaccount.com ')).toBe('reader@proj.iam.gserviceaccount.com');
  });

  it('throws on a value the next launch\'s validator would reject', () => {
    expect(() => wizardWriteReader('someone@gmail.com')).toThrow(/service-account address/);
    expect(() => wizardWriteReader(42)).toThrow(/service-account address/);
  });
});
