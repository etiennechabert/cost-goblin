import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadConfig, loadDimensions, loadOrgTree, ConfigValidationError } from '../config/index.js';
import { validateConfig, validateDimensions, validateOrgTree } from '../config/validator.js';
import type { AwsProviderConfig, GcpProviderConfig, ProviderConfig } from '../types/config.js';

const fixturesDir = join(import.meta.dirname, '..', '__fixtures__', 'config');

/** Narrow a validated provider to the `aws` arm — `credentialsProfile` only
 *  exists there, so every assertion on it goes through this. Throws (failing
 *  the test loudly) when the arm is wrong. */
function awsArm(p: ProviderConfig | undefined): AwsProviderConfig {
  if (p?.type !== 'aws') throw new Error(`expected an 'aws' provider, got ${String(p?.type)}`);
  return p;
}

function gcpArm(p: ProviderConfig | undefined): GcpProviderConfig {
  if (p?.type !== 'gcp') throw new Error(`expected a 'gcp' provider, got ${String(p?.type)}`);
  return p;
}

describe('loadConfig', () => {
  it('loads and validates costgoblin.yaml', async () => {
    const config = await loadConfig(join(fixturesDir, 'costgoblin.yaml'));
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.type).toBe('aws');
    expect(config.providers[0]?.name).toBe('aws-main');
    expect(awsArm(config.providers[0]).credentialsProfile).toBe('test-profile');
    expect(config.providers[0]?.sync.daily.retentionDays).toBe(365);
    expect(config.providers[0]?.sync.hourly?.retentionDays).toBe(30);
    expect(config.defaults.periodDays).toBe(30);
  });
});

describe('loadDimensions', () => {
  it('loads built-in and tag dimensions', async () => {
    const dims = await loadDimensions(join(fixturesDir, 'dimensions.yaml'));
    expect(dims.builtIn).toHaveLength(13);
    expect(dims.builtIn[0]?.name).toBe('account');
    expect(dims.builtIn[0]?.displayField).toBe('account_name');
    expect(dims.tags).toHaveLength(4);
    expect(dims.tags[0]?.concept).toBe('owner');
    expect(dims.tags[0]?.normalize).toBe('lowercase-kebab');
    expect(dims.tags[0]?.aliases?.['core-banking']).toContain('corebanking');
  });
});

describe('loadOrgTree', () => {
  it('loads org tree with virtual and real nodes', async () => {
    const tree = await loadOrgTree(join(fixturesDir, 'org-tree.yaml'));
    expect(tree.tree).toHaveLength(1);
    const company = tree.tree[0];
    expect(company?.name).toBe('Company');
    expect(company?.virtual).toBe(true);
    expect(company?.children).toHaveLength(3);

    const engineering = company?.children?.[0];
    expect(engineering?.name).toBe('Engineering');
    expect(engineering?.virtual).toBe(true);
    expect(engineering?.children).toHaveLength(4);

    const sre = company?.children?.[2];
    expect(sre?.name).toBe('SRE');
    expect(sre?.virtual).toBeUndefined();
    expect(sre?.children).toHaveLength(2);
  });
});

describe('validateConfig', () => {
  it('throws on invalid input', () => {
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
    expect(() => validateConfig({})).toThrow(ConfigValidationError);
    expect(() => validateConfig({ providers: 'not-array' })).toThrow(ConfigValidationError);
  });

  it('throws on missing provider fields', () => {
    expect(() => validateConfig({
      providers: [{ name: 'test' }],
      defaults: { periodDays: 30, costMetric: 'x', lagDays: 1 },
    })).toThrow(ConfigValidationError);
  });

  it('accepts the flattened credentialsProfile field', () => {
    const config = validateConfig({
      providers: [{
        name: 'payer-a', type: 'aws', credentialsProfile: 'billing-a',
        sync: { daily: { bucket: 's3://b/daily', retentionDays: 30 }, intervalMinutes: 60 },
      }],
      defaults: { periodDays: 30, costMetric: 'unblended_cost', lagDays: 1 },
    });
    expect(awsArm(config.providers[0]).credentialsProfile).toBe('billing-a');
  });

  it('accepts the legacy nested credentials.profile shape and migrates it', () => {
    const config = validateConfig({
      providers: [{
        name: 'payer-a', type: 'aws', credentials: { profile: 'legacy-profile' },
        sync: { daily: { bucket: 's3://b/daily', retentionDays: 30 }, intervalMinutes: 60 },
      }],
      defaults: { periodDays: 30, costMetric: 'unblended_cost', lagDays: 1 },
    });
    expect(awsArm(config.providers[0]).credentialsProfile).toBe('legacy-profile');
  });

  it('rejects a provider name that is not filesystem/SQL-safe', () => {
    const withName = (name: string): unknown => ({
      providers: [{
        name, type: 'aws', credentialsProfile: 'p',
        sync: { daily: { bucket: 's3://b/daily', retentionDays: 30 }, intervalMinutes: 60 },
      }],
      defaults: { periodDays: 30, costMetric: 'unblended_cost', lagDays: 1 },
    });
    expect(() => validateConfig(withName('../escape'))).toThrow(ConfigValidationError);
    expect(() => validateConfig(withName("payer'; DROP"))).toThrow(ConfigValidationError);
    expect(() => validateConfig(withName('raw'))).toThrow(ConfigValidationError);
    expect(() => validateConfig(withName('ok-name'))).not.toThrow();
  });

  it('rejects duplicate provider names case-insensitively', () => {
    const provider = (name: string): unknown => ({
      name, type: 'aws', credentialsProfile: 'p',
      sync: { daily: { bucket: 's3://b/daily', retentionDays: 30 }, intervalMinutes: 60 },
    });
    expect(() => validateConfig({
      providers: [provider('payer-a'), provider('Payer-A')],
      defaults: { periodDays: 30, costMetric: 'unblended_cost', lagDays: 1 },
    })).toThrow(ConfigValidationError);
    expect(() => validateConfig({
      providers: [provider('payer-a'), provider('payer-b')],
      defaults: { periodDays: 30, costMetric: 'unblended_cost', lagDays: 1 },
    })).not.toThrow();
  });

  it('rejects a sync bucket that is not a plausible S3 location', () => {
    const withBucket = (bucket: string): unknown => ({
      providers: [{
        name: 'aws', type: 'aws', credentialsProfile: 'p',
        sync: { daily: { bucket, retentionDays: 30 }, intervalMinutes: 60 },
      }],
      defaults: { periodDays: 30, costMetric: 'unblended_cost', lagDays: 1 },
    });
    // An imported bundle must not smuggle a leading-dash flag, a newline/control
    // char, or `..` traversal into the `aws s3 sync` source argument.
    expect(() => validateConfig(withBucket('-rf'))).toThrow(ConfigValidationError);
    expect(() => validateConfig(withBucket('bucket/../../../etc'))).toThrow(ConfigValidationError);
    expect(() => validateConfig(withBucket('evil\n--profile=x'))).toThrow(ConfigValidationError);
    // Normal S3 locations still pass — including legitimate key characters like
    // a CUR 2.0 Hive partition prefix, which must not be over-rejected.
    expect(() => validateConfig(withBucket('s3://my-cur-bucket/daily/'))).not.toThrow();
    expect(() => validateConfig(withBucket('my-cur-bucket/daily'))).not.toThrow();
    expect(() => validateConfig(withBucket('s3://my-bucket/cur/BILLING_PERIOD=2026-06/'))).not.toThrow();
  });
});

describe('validateConfig — gcp provider arm', () => {
  const gcp = (overrides: Record<string, unknown> = {}): unknown => ({
    providers: [{
      name: 'gcp-main',
      type: 'gcp',
      sync: { daily: { bucket: 'gs://billing-export/focus', retentionDays: 365 }, intervalMinutes: 60 },
      ...overrides,
    }],
    defaults: { periodDays: 30, costMetric: 'effective', lagDays: 1 },
  });

  it('accepts a minimal gcp provider and defaults to Application Default Credentials', () => {
    const provider = gcpArm(validateConfig(gcp()).providers[0]);
    expect(provider.type).toBe('gcp');
    expect(String(provider.sync.daily.bucket)).toBe('gs://billing-export/focus');
    expect(provider.sync.daily.retentionDays).toBe(365);
    expect(provider.sync.intervalMinutes).toBe(60);
    // Absent rather than an explicit undefined value — the key must not be
    // written back to YAML on a round-trip.
    expect('keyFile' in provider).toBe(false);
  });

  it('keeps an explicit service-account key file', () => {
    const provider = gcpArm(validateConfig(gcp({ keyFile: '/home/me/sa-key.json' })).providers[0]);
    expect(provider.keyFile).toBe('/home/me/sa-key.json');
  });

  it('rejects an empty or control-character keyFile', () => {
    expect(() => validateConfig(gcp({ keyFile: '' }))).toThrow(ConfigValidationError);
    expect(() => validateConfig(gcp({ keyFile: 'key\n.json' }))).toThrow(ConfigValidationError);
    expect(() => validateConfig(gcp({ keyFile: 42 }))).toThrow(ConfigValidationError);
  });

  it('accepts a bare bucket/prefix as well as a gs:// URL, and rejects an s3:// one', () => {
    const withBucket = (bucket: string): unknown =>
      gcp({ sync: { daily: { bucket, retentionDays: 365 }, intervalMinutes: 60 } });
    expect(() => validateConfig(withBucket('gs://billing-export/focus/'))).not.toThrow();
    expect(() => validateConfig(withBucket('billing-export/focus'))).not.toThrow();
    // The exporter writes lowercase Hive folders — those characters must pass.
    expect(() => validateConfig(withBucket('gs://b/focus/billing_period=2026-07/'))).not.toThrow();
    // Pasting the AWS bucket into the GCP form is a real mistake; catch it at
    // load time rather than as a silently empty listing.
    expect(() => validateConfig(withBucket('s3://my-cur-bucket/daily'))).toThrow(ConfigValidationError);
    expect(() => validateConfig(withBucket('-rf'))).toThrow(ConfigValidationError);
    expect(() => validateConfig(withBucket('b/../../etc'))).toThrow(ConfigValidationError);
  });

  it('accepts a service account to impersonate, and rejects a malformed one', () => {
    const sa = 'costgoblin-reader@billing-504501.iam.gserviceaccount.com';
    expect(gcpArm(validateConfig(gcp({ impersonateServiceAccount: sa })).providers[0]).impersonateServiceAccount).toBe(sa);
    // Absent rather than an explicit undefined — it must not be written back
    // to YAML on a round-trip.
    expect('impersonateServiceAccount' in gcpArm(validateConfig(gcp()).providers[0])).toBe(false);

    // The value reaches the gcloud CLI as `--impersonate-service-account=<v>`
    // in an argv array, and a config can arrive from a shared bundle — so it
    // is checked against the service-account grammar, not taken on trust.
    for (const bad of [
      'not-an-email',
      'someone@gmail.com',
      'reader@project.example.com',
      '--flag-injection@p.iam.gserviceaccount.com',
      'x@p.iam.gserviceaccount.com evil',
      '',
      42,
    ]) {
      expect(() => validateConfig(gcp({ impersonateServiceAccount: bad })), String(bad)).toThrow(ConfigValidationError);
    }
  });

  it('rejects a key file combined with impersonation, which would split the two halves of a sync', () => {
    const sa = 'costgoblin-reader@billing-504501.iam.gserviceaccount.com';
    // Each alone is fine.
    expect(() => validateConfig(gcp({ keyFile: '/home/me/sa-key.json' }))).not.toThrow();
    expect(() => validateConfig(gcp({ impersonateServiceAccount: sa }))).not.toThrow();

    // Together they are contradictory, and the failure was silent: the download
    // half passes `--impersonate-service-account` to gcloud while the listing
    // half authenticates with the key alone, so listing ran as the key holder —
    // who the least-privilege recipe grants nothing — and returned a bare 403.
    expect(() => validateConfig(gcp({ keyFile: '/home/me/sa-key.json', impersonateServiceAccount: sa })))
      .toThrow(ConfigValidationError);
  });

  it('accepts an hourly tier alongside daily', () => {
    // The GCP FOCUS export is delivered at HOURLY grain; the exporter
    // publishes it untouched under …/hourly/ and a rollup under …/daily/,
    // so a GCP provider carries the same two tiers an AWS one does.
    const provider = gcpArm(validateConfig(gcp({
      sync: {
        daily: { bucket: 'gs://b/focus/daily', retentionDays: 365 },
        hourly: { bucket: 'gs://b/focus/hourly', retentionDays: 14 },
        intervalMinutes: 60,
      },
    })).providers[0]);
    expect(String(provider.sync.hourly?.bucket)).toBe('gs://b/focus/hourly');
    expect(provider.sync.hourly?.retentionDays).toBe(14);
  });

  it('omits hourly entirely when it is not configured', () => {
    // Absent rather than an explicit undefined, so a round-trip through the
    // sharing bundle does not write an empty `hourly:` key back to YAML.
    expect('hourly' in gcpArm(validateConfig(gcp()).providers[0])).toBe(false);
  });

  it('applies the gs:// bucket rules to the hourly tier too', () => {
    expect(() => validateConfig(gcp({
      sync: {
        daily: { bucket: 'gs://b/focus/daily', retentionDays: 365 },
        hourly: { bucket: 's3://b/focus/hourly', retentionDays: 14 },
        intervalMinutes: 60,
      },
    }))).toThrow(ConfigValidationError);
  });

  it('rejects two tiers pointed at one folder', () => {
    // Both tiers reading the same objects would sync identical rows into
    // raw/daily-* AND raw/hourly-*, so the intraday views would render the
    // daily grain and the tiers would fight over retention.
    expect(() => validateConfig(gcp({
      sync: {
        daily: { bucket: 'gs://b/focus', retentionDays: 365 },
        hourly: { bucket: 'gs://b/focus', retentionDays: 14 },
        intervalMinutes: 60,
      },
    }))).toThrow(/must not overlap/);
  });

  it('rejects an hourly bucket nested inside the daily one', () => {
    // Exact equality is not enough: the exporter writes <prefix>/daily/ and
    // <prefix>/hourly/, so a daily bucket left at the bare prefix — what
    // following deploy.sh's closing line used to produce — would still make
    // the daily listing match every hourly shard.
    expect(() => validateConfig(gcp({
      sync: {
        daily: { bucket: 'gs://b/focus', retentionDays: 365 },
        hourly: { bucket: 'gs://b/focus/hourly', retentionDays: 14 },
        intervalMinutes: 60,
      },
    }))).toThrow(/must not overlap/);
    // A trailing-slash variant of the same daily bucket is the same overlap.
    expect(() => validateConfig(gcp({
      sync: {
        daily: { bucket: 'gs://b/focus/daily', retentionDays: 365 },
        hourly: { bucket: 'gs://b/focus/daily/', retentionDays: 14 },
        intervalMinutes: 60,
      },
    }))).toThrow(/must not overlap/);
  });

  it('rejects costOptimization, which has no GCP analogue, instead of ignoring it', () => {
    expect(() => validateConfig(gcp({
      sync: {
        daily: { bucket: 'gs://b/focus', retentionDays: 365 },
        costOptimization: { bucket: 'gs://b/other', retentionDays: 30 },
        intervalMinutes: 60,
      },
    }))).toThrow(ConfigValidationError);
  });

  it('does not require credentialsProfile on the gcp arm, and still requires it on aws', () => {
    expect(() => validateConfig(gcp())).not.toThrow();
    expect(() => validateConfig({
      providers: [{ name: 'payer-a', type: 'aws', sync: { daily: { bucket: 's3://b/d', retentionDays: 30 }, intervalMinutes: 60 } }],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 1 },
    })).toThrow(ConfigValidationError);
  });

  it('still rejects an unknown provider type', () => {
    expect(() => validateConfig({
      providers: [{ name: 'azure-main', type: 'azure', sync: { daily: { bucket: 'b/d', retentionDays: 30 }, intervalMinutes: 60 } }],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 1 },
    })).toThrow(/must be 'aws' or 'gcp'/);
  });

  it('applies the shared name rules across arms — a gcp name collides with an aws one', () => {
    expect(() => validateConfig({
      providers: [
        { name: 'payer-a', type: 'aws', credentialsProfile: 'p', sync: { daily: { bucket: 's3://b/d', retentionDays: 30 }, intervalMinutes: 60 } },
        { name: 'Payer-A', type: 'gcp', sync: { daily: { bucket: 'gs://b/f', retentionDays: 30 }, intervalMinutes: 60 } },
      ],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 1 },
    })).toThrow(ConfigValidationError);
  });
});

describe('validateDimensions', () => {
  it('rejects invalid normalization rule', () => {
    expect(() => validateDimensions({
      builtIn: [],
      tags: [{ tagName: 'x', label: 'X', normalize: 'invalid' }],
    })).toThrow(ConfigValidationError);
  });

  it('strips the CUR-era user_ prefix from persisted tagNames (FOCUS Tags keys carry none)', () => {
    const dims = validateDimensions({
      builtIn: [],
      tags: [{ tagName: 'user_team', label: 'Team' }],
    });
    expect(dims.tags[0]?.tagName).toBe('team');
  });

  it('accepts a legitimately-named built-in column', () => {
    expect(() => validateDimensions({
      builtIn: [{ name: 'svc', label: 'Service', field: 'product_service_name', displayField: 'account_name' }],
      tags: [],
    })).not.toThrow();
  });

  it('rejects a built-in field that smuggles SQL injection', () => {
    expect(() => validateDimensions({
      builtIn: [{ name: 'x', label: 'X', field: 'account_id) OR 1=1 --' }],
      tags: [],
    })).toThrow(ConfigValidationError);
  });

  it('rejects a built-in displayField that smuggles SQL injection', () => {
    expect(() => validateDimensions({
      builtIn: [{ name: 'x', label: 'X', field: 'account_id', displayField: 'name; DROP TABLE cost_base' }],
      tags: [],
    })).toThrow(ConfigValidationError);
  });

  it('drops alias entries with empty lists', () => {
    const dims = validateDimensions({
      builtIn: [],
      tags: [{ tagName: 'x', label: 'X', aliases: { production: [], development: ['dev'] } }],
    });
    expect(dims.tags[0]?.aliases).toEqual({ development: ['dev'] });
  });
});

describe('validateOrgTree', () => {
  it('validates nested structure', () => {
    const tree = validateOrgTree({
      tree: [{ name: 'Root', virtual: true, children: [{ name: 'leaf' }] }],
    });
    expect(tree.tree[0]?.children?.[0]?.name).toBe('leaf');
  });
});
