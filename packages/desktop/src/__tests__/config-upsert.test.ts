import { describe, it, expect } from 'vitest';
import { ProviderNameError } from '@costgoblin/core';
import { upsertWizardProvider, swapProviderCredentialsProfile } from '../main/config-upsert.js';

function providerA(): Record<string, unknown> {
  return {
    name: 'aws-main',
    type: 'aws',
    credentialsProfile: 'main-profile',
    sync: {
      daily: { bucket: 's3://bucket-a/daily/', retentionDays: 90 },
      hourly: { bucket: 's3://bucket-a/hourly/', retentionDays: 14 },
      intervalMinutes: 30,
    },
  };
}

function providerB(): Record<string, unknown> {
  return {
    name: 'aws-payer-b',
    type: 'aws',
    credentialsProfile: 'payer-b',
    sync: { daily: { bucket: 's3://bucket-b/daily/', retentionDays: 365 }, intervalMinutes: 60 },
  };
}

function providerGcp(): Record<string, unknown> {
  return {
    name: 'gcp-main',
    type: 'gcp',
    sync: { daily: { bucket: 'gs://billing-export/focus/', retentionDays: 365 }, intervalMinutes: 60 },
  };
}

function providers(config: Record<string, unknown>): unknown[] {
  const value = config['providers'];
  if (!Array.isArray(value)) throw new Error('expected providers array');
  return value;
}

describe('upsertWizardProvider', () => {
  it('appends a new provider when no entry matches the name, preserving existing entries verbatim', () => {
    const a = providerA();
    const result = upsertWizardProvider({ providers: [a] }, {
      providerName: 'aws-payer-b',
      profile: 'payer-b',
      dailyBucket: 's3://bucket-b/daily/',
    });
    const list = providers(result);
    expect(list).toHaveLength(2);
    expect(list[0]).toBe(a); // untouched, same reference
    expect(list[1]).toEqual({
      name: 'aws-payer-b',
      type: 'aws',
      credentialsProfile: 'payer-b',
      sync: { intervalMinutes: 60, daily: { bucket: 's3://bucket-b/daily/', retentionDays: 365 } },
    });
  });

  it('replaces a matching provider in place, preserving its position and the other entries', () => {
    const a = providerA();
    const b = providerB();
    const c = { name: 'aws-payer-c', type: 'aws', credentialsProfile: 'payer-c', sync: { intervalMinutes: 60 } };
    const result = upsertWizardProvider({ providers: [a, b, c] }, {
      providerName: 'aws-payer-b',
      profile: 'payer-b-readonly',
      dailyBucket: 's3://bucket-b2/daily/',
      retentionDays: 30,
    });
    const list = providers(result);
    expect(list).toHaveLength(3);
    expect(list[0]).toBe(a);
    expect(list[2]).toBe(c);
    expect(list[1]).toEqual({
      name: 'aws-payer-b',
      type: 'aws',
      credentialsProfile: 'payer-b-readonly',
      sync: { intervalMinutes: 60, daily: { bucket: 's3://bucket-b2/daily/', retentionDays: 30 } },
    });
  });

  it('merges the TARGETED provider existing sync sub-fields, not those of providers[0]', () => {
    const a = providerA(); // has an hourly sync block
    const b = providerB(); // daily only
    const result = upsertWizardProvider({ providers: [a, b] }, {
      providerName: 'aws-payer-b',
      profile: 'payer-b',
      dailyBucket: 's3://bucket-b/daily/',
    });
    const list = providers(result);
    const rewritten = list[1];
    expect(rewritten).toEqual({
      name: 'aws-payer-b',
      type: 'aws',
      credentialsProfile: 'payer-b',
      // no `hourly` leaked from provider A
      sync: { intervalMinutes: 60, daily: { bucket: 's3://bucket-b/daily/', retentionDays: 365 } },
    });
  });

  it('keeps existing sync sub-fields the wizard run did not mention (hourly/costOptimization)', () => {
    const a = providerA();
    const result = upsertWizardProvider({ providers: [a] }, {
      providerName: 'aws-main',
      profile: 'main-profile-2',
      dailyBucket: 's3://bucket-a2/daily/',
    });
    const list = providers(result);
    expect(list[0]).toEqual({
      name: 'aws-main',
      type: 'aws',
      credentialsProfile: 'main-profile-2',
      sync: {
        hourly: { bucket: 's3://bucket-a/hourly/', retentionDays: 14 },
        intervalMinutes: 60,
        daily: { bucket: 's3://bucket-a2/daily/', retentionDays: 365 },
      },
    });
  });

  it('writes hourly and costOptimization blocks when the wizard provides those buckets', () => {
    const result = upsertWizardProvider({}, {
      providerName: 'aws-main',
      profile: 'default',
      dailyBucket: 's3://b/daily/',
      hourlyBucket: 's3://b/hourly/',
      costOptBucket: 's3://b/co/',
    });
    expect(providers(result)[0]).toEqual({
      name: 'aws-main',
      type: 'aws',
      credentialsProfile: 'default',
      sync: {
        intervalMinutes: 60,
        daily: { bucket: 's3://b/daily/', retentionDays: 365 },
        hourly: { bucket: 's3://b/hourly/', retentionDays: 30 },
        costOptimization: { bucket: 's3://b/co/', retentionDays: 30 },
      },
    });
  });

  it('preserves unknown top-level YAML keys and an existing defaults block', () => {
    const defaults = { periodDays: 7, costMetric: 'AmortizedCost', lagDays: 1 };
    const result = upsertWizardProvider(
      { providers: [providerA()], defaults, customKey: { nested: true } },
      { providerName: 'aws-main', profile: 'p', dailyBucket: 's3://b/daily/' },
    );
    expect(result['customKey']).toEqual({ nested: true });
    expect(result['defaults']).toBe(defaults);
  });

  it('adds the standard defaults block when none exists', () => {
    const result = upsertWizardProvider({}, { providerName: 'aws-main', profile: 'p', dailyBucket: 's3://b/' });
    expect(result['defaults']).toEqual({ periodDays: 30, costMetric: 'effective', lagDays: 2 });
  });

  it('drops a legacy nested credentials key when rewriting the targeted provider', () => {
    const legacy = {
      name: 'aws-main',
      type: 'aws',
      credentials: { profile: 'old-profile' },
      sync: { daily: { bucket: 's3://old/', retentionDays: 365 }, intervalMinutes: 60 },
    };
    const result = upsertWizardProvider({ providers: [legacy] }, {
      providerName: 'aws-main',
      profile: 'new-profile',
      dailyBucket: 's3://new/',
    });
    const entry = providers(result)[0];
    expect(entry).toEqual({
      name: 'aws-main',
      type: 'aws',
      credentialsProfile: 'new-profile',
      sync: { intervalMinutes: 60, daily: { bucket: 's3://new/', retentionDays: 365 } },
    });
  });

  it('refuses to rewrite a gcp provider as aws when the wizard payload carries no type', () => {
    // The wizard has never sent a `type`, so `type` defaults to 'aws'. Without
    // this guard an upsert matching a gcp entry by name silently replaced it
    // with {type:'aws', credentialsProfile:…, sync.daily.bucket:'s3://…'} —
    // the GCP source vanished rather than the write failing.
    const gcpEntry = {
      name: 'gcp-main',
      type: 'gcp',
      sync: { daily: { bucket: 'gs://cost-goblin/focus/', retentionDays: 365 }, intervalMinutes: 60 },
    };
    expect(() => upsertWizardProvider({ providers: [gcpEntry] }, {
      providerName: 'gcp-main', profile: 'default', dailyBucket: 's3://some-bucket/daily/',
    })).toThrow(/GCP provider/);

    // An explicit gcp payload still targets it, and an unrelated aws name is
    // unaffected.
    expect(() => upsertWizardProvider({ providers: [gcpEntry] }, {
      providerName: 'gcp-main', type: 'gcp', profile: '', dailyBucket: 'gs://other/focus/',
    })).not.toThrow();
    expect(() => upsertWizardProvider({ providers: [gcpEntry] }, {
      providerName: 'aws-main', profile: 'default', dailyBucket: 's3://b/',
    })).not.toThrow();
  });

  it('rejects invalid provider names with a friendly ProviderNameError', () => {
    const wizard = { profile: 'p', dailyBucket: 's3://b/' };
    expect(() => upsertWizardProvider({}, { ...wizard, providerName: '' })).toThrow(ProviderNameError);
    expect(() => upsertWizardProvider({}, { ...wizard, providerName: 'a/b' })).toThrow(ProviderNameError);
    expect(() => upsertWizardProvider({}, { ...wizard, providerName: 'raw' })).toThrow(/reserved/);
    expect(() => upsertWizardProvider({}, { ...wizard, providerName: '-lead' }))
      .toThrow('Provider names must start with a letter or number and may only contain letters, numbers, hyphens, and underscores.');
  });
});

describe('swapProviderCredentialsProfile', () => {
  it('defaults to the first provider and leaves the others untouched', () => {
    const a = providerA();
    const b = providerB();
    const result = swapProviderCredentialsProfile({ providers: [a, b], defaults: { periodDays: 30 } }, 'swapped');
    const list = providers(result);
    expect(list[0]).toEqual({ ...providerA(), credentialsProfile: 'swapped' });
    expect(list[1]).toBe(b);
    expect(result['defaults']).toEqual({ periodDays: 30 });
  });

  it('targets a provider by exact name, preserving positions', () => {
    const a = providerA();
    const b = providerB();
    const result = swapProviderCredentialsProfile({ providers: [a, b] }, 'swapped', 'aws-payer-b');
    const list = providers(result);
    expect(list[0]).toBe(a);
    expect(list[1]).toEqual({ ...providerB(), credentialsProfile: 'swapped' });
  });

  it('drops the legacy credentials key on the targeted entry only', () => {
    const legacyA = { name: 'aws-main', type: 'aws', credentials: { profile: 'old-a' }, sync: {} };
    const legacyB = { name: 'aws-payer-b', type: 'aws', credentials: { profile: 'old-b' }, sync: {} };
    const result = swapProviderCredentialsProfile({ providers: [legacyA, legacyB] }, 'new-b', 'aws-payer-b');
    const list = providers(result);
    expect(list[0]).toBe(legacyA); // untouched, keeps its legacy key
    expect(list[1]).toEqual({ name: 'aws-payer-b', type: 'aws', sync: {}, credentialsProfile: 'new-b' });
  });

  it('throws Unknown provider for a name that is not configured', () => {
    expect(() => swapProviderCredentialsProfile({ providers: [providerA()] }, 'p', 'nope'))
      .toThrow('Unknown provider "nope"');
  });

  it('throws when no providers are configured', () => {
    expect(() => swapProviderCredentialsProfile({}, 'p')).toThrow('No providers configured');
    expect(() => swapProviderCredentialsProfile({ providers: [] }, 'p')).toThrow('No providers configured');
  });

  it('throws when the targeted entry is not an object', () => {
    expect(() => swapProviderCredentialsProfile({ providers: ['bogus'] }, 'p')).toThrow('Provider entry is not an object');
  });

  it('refuses to stamp an AWS profile onto a gcp provider', () => {
    expect(() => swapProviderCredentialsProfile({ providers: [providerGcp()] }, 'p', 'gcp-main'))
      .toThrow(/GCP provider/);
    // Also when it is the implicit first-provider target.
    expect(() => swapProviderCredentialsProfile({ providers: [providerGcp()] }, 'p'))
      .toThrow(/GCP provider/);
  });
});

describe('upsertWizardProvider — gcp arm', () => {
  it('writes a gcp entry with no credentialsProfile, carrying both real tiers', () => {
    const result = upsertWizardProvider({}, {
      providerName: 'gcp-main',
      type: 'gcp',
      profile: '',
      dailyBucket: 'gs://billing-export/focus/daily/',
      retentionDays: 365,
      hourlyBucket: 'gs://billing-export/focus/hourly/',
      // Supplied by the shared wizard payload but meaningless for GCP, which
      // has no Cost Optimization Hub analogue — it must not reach the file.
      costOptBucket: 'gs://billing-export/cost-opt/',
    });
    expect(providers(result)[0]).toEqual({
      name: 'gcp-main',
      type: 'gcp',
      sync: {
        intervalMinutes: 60,
        daily: { bucket: 'gs://billing-export/focus/daily/', retentionDays: 365 },
        hourly: { bucket: 'gs://billing-export/focus/hourly/', retentionDays: 30 },
      },
    });
  });

  it('omits hourly for a gcp entry when the wizard did not supply one', () => {
    const result = upsertWizardProvider({}, {
      providerName: 'gcp-main', type: 'gcp', profile: '',
      dailyBucket: 'gs://billing-export/focus/',
    });
    expect(providers(result)[0]).toEqual({
      name: 'gcp-main',
      type: 'gcp',
      sync: { intervalMinutes: 60, daily: { bucket: 'gs://billing-export/focus/', retentionDays: 365 } },
    });
  });

  it('keeps an explicit key file and omits it when blank', () => {
    const withKey = upsertWizardProvider({}, {
      providerName: 'gcp-main', type: 'gcp', profile: '',
      dailyBucket: 'gs://b/focus', keyFile: '/home/me/sa.json',
    });
    expect(providers(withKey)[0]).toMatchObject({ keyFile: '/home/me/sa.json' });

    const blank = upsertWizardProvider({}, {
      providerName: 'gcp-main', type: 'gcp', profile: '',
      dailyBucket: 'gs://b/focus', keyFile: '',
    });
    const entry = providers(blank)[0];
    expect(entry).not.toHaveProperty('keyFile');
  });

  it('refuses to rewrite an aws entry as gcp under the same name', () => {
    // The mirror image of the aws-over-gcp guard above. Before this guard
    // covered both directions, a `type: 'gcp'` payload landing on an existing
    // aws entry replaced it wholesale — dropping `credentialsProfile` and the
    // inherited sync tiers, with the AWS billing source simply gone and no
    // error anywhere.
    expect(() => upsertWizardProvider({ providers: [providerA()] }, {
      providerName: 'aws-main', type: 'gcp', profile: '',
      dailyBucket: 'gs://b/focus',
    })).toThrow(/is a AWS provider — refusing to rewrite it as GCP/);
  });

  it('still writes an aws entry when type is omitted', () => {
    const result = upsertWizardProvider({}, {
      providerName: 'aws-main', profile: 'main-profile', dailyBucket: 's3://b/daily',
    });
    expect(providers(result)[0]).toMatchObject({ type: 'aws', credentialsProfile: 'main-profile' });
  });
});
