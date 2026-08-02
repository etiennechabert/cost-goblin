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
    expect(result['defaults']).toEqual({ periodDays: 30, costMetric: 'UnblendedCost', lagDays: 2 });
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
});
