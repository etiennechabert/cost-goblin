import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProviderName } from '../config/provider-name.js';
import { ConfigValidationError, validateConfig, validateDimensions } from '../config/validator.js';
import { logger } from '../logger/logger.js';
import { findTagIdCollisions } from '../types/branded.js';

// Two arms of validator.ts guard against collaborators misbehaving in ways
// the real ones never do: parseProviderName only throws ProviderNameError,
// and findTagIdCollisions only reports indexes inside the list it was given.
// Both are pass-through spies, so a test injects the misbehaviour with a
// `...Once` and everything else runs the real code.
vi.mock('../config/provider-name.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/provider-name.js')>();
  return { ...actual, parseProviderName: vi.fn(actual.parseProviderName) };
});
vi.mock('../types/branded.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types/branded.js')>();
  return { ...actual, findTagIdCollisions: vi.fn(actual.findTagIdCollisions) };
});

/** The message of the ConfigValidationError `fn` throws; anything else fails the test. */
function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigValidationError, but nothing was thrown');
}

const config = {
  providers: [{
    name: 'payer-a',
    type: 'aws',
    credentialsProfile: 'default',
    sync: { daily: { bucket: 's3://billing/daily', retentionDays: 365 }, intervalMinutes: 60 },
  }],
  defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
};

afterEach(() => { vi.restoreAllMocks(); });

describe('validateConfig: provider name failures', () => {
  it('prefixes the provider-name error with the provider path', () => {
    expect(configError(() => validateConfig({ ...config, providers: [{ ...config.providers[0], name: 'bad name!' }] })))
      .toBe('providers[0].name: Provider names must start with a letter or number and may only contain letters, numbers, hyphens, and underscores.');
  });

  it('reports a failure that is not an Error by its string form', () => {
    vi.mocked(parseProviderName).mockImplementationOnce(() => {
      const reason: unknown = 'name registry unavailable';
      throw reason;
    });
    expect(configError(() => validateConfig(config))).toBe('providers[0].name: name registry unavailable');
  });
});

describe('validateDimensions: a reported collision outside the tag list', () => {
  const tags = [{ tagName: 'team', label: 'Team' }];

  it('names the missing tag "unknown" when rejecting', () => {
    vi.mocked(findTagIdCollisions).mockReturnValueOnce([{ id: 'tag_team', ownerIndex: 0, index: 5 }]);
    expect(configError(() => validateDimensions({ builtIn: [], tags }, { tagIdCollisions: 'reject' })))
      .toBe('tags[5] (unknown) has the same dimension id, tag_team, as tags[0] (tag "team"): it would show that dimension\'s data. Remove one of them.');
  });

  it('warns about it on load without disabling any real tag', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.mocked(findTagIdCollisions).mockReturnValueOnce([{ id: 'tag_team', ownerIndex: 0, index: 5 }]);
    const dims = validateDimensions({ builtIn: [], tags });
    expect(dims.tags).toStrictEqual(tags);
    expect(warn).toHaveBeenCalledWith(
      'tags[5] (unknown) has the same dimension id, tag_team, as tags[0] (tag "team"), so it would show that dimension\'s data; it is disabled. Remove one of them in Dimensions.',
    );
  });
});
