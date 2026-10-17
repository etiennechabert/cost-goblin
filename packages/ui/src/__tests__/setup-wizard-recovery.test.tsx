import type { CheckConfigBeaconParams, CheckConfigBeaconResult, CostApi, GcsBrowseResult } from '@costgoblin/core/browser';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_BUNDLE_SUMMARY, MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { SetupWizard } from '../views/setup-wizard.js';

type S3Browse = Awaited<ReturnType<CostApi['browseS3']>>;

const BILLING_FOLDER: S3Browse = { prefixes: ['data', 'metadata'], isBillingExport: true, detectedType: 'daily', missingColumns: [], fileVersioning: 'overwrite' };

function folder(prefixes: string[]): S3Browse {
  return { prefixes, isBillingExport: false, detectedType: 'unknown', missingColumns: [], fileVersioning: 'unknown' };
}

/** A mock whose S3 browse answers per prefix, and records every prefix asked. */
class WizardApi extends MockCostApi {
  readonly s3ByPrefix = new Map<string, S3Browse>();
  readonly s3Browsed: string[] = [];
  /** Rejects the next browse with this reason, once. */
  browseFailure: unknown = undefined;

  override browseS3(params?: Parameters<CostApi['browseS3']>[0]): ReturnType<CostApi['browseS3']> {
    const prefix = params?.prefix ?? '';
    this.s3Browsed.push(prefix);
    if (this.browseFailure !== undefined) {
      const failure = this.browseFailure;
      this.browseFailure = undefined;
      return vi.fn<() => Promise<S3Browse>>().mockRejectedValue(failure)();
    }
    return Promise.resolve(this.s3ByPrefix.get(prefix) ?? this.s3BrowseResult);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Outcome = 'resolve' | 'reject';

/** Hands `install` a promise to answer with, and returns how to settle it
 *  later: with `value`, or with a failure. */
function hold<T>(install: (pending: Promise<T>) => void, value: T): (outcome: Outcome) => void {
  const pending = deferred<T>();
  install(pending.promise);
  return (outcome) => {
    if (outcome === 'resolve') pending.resolve(value);
    else pending.reject(new Error('late failure'));
  };
}

type Answer<K extends keyof MockCostApi> = MockCostApi[K] extends (...args: never[]) => Promise<infer R> ? R : never;

const FOUND: CheckConfigBeaconResult = {
  status: 'found',
  location: 's3://my-cur-bucket/costgoblin/org-config.yaml',
  content: 'kind: costgoblin-config-bundle',
  summary: MOCK_BUNDLE_SUMMARY,
};

function renderWizard(api: WizardApi = new WizardApi(), props: { workspaceNaming?: { initialName: string }; otherWorkspaces?: readonly string[]; gcpSource?: { bucket: string; prefix: string } } = {}) {
  const onComplete = vi.fn<(result?: { workspaceName?: string }) => void>();
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <SetupWizard
        onComplete={onComplete}
        workspaceNaming={props.workspaceNaming}
        otherWorkspaces={props.otherWorkspaces}
        gcpSource={props.gcpSource}
        {...(props.gcpSource === undefined ? {} : { source: 'daily' as const, providerName: 'gcp-main' })}
      />
    </CostApiProvider>,
  );
  return { api, user, onComplete };
}

type User = ReturnType<typeof userEvent.setup>;

async function toBucketStep(user: User): Promise<void> {
  await user.click(screen.getByLabelText('Set up from AWS'));
  await user.click(await screen.findByRole('button', { name: 'default' }));
  await screen.findByText('my-cur-bucket');
}

async function toBrowse(user: User): Promise<void> {
  await toBucketStep(user);
  await user.click(screen.getByText('my-cur-bucket'));
  await screen.findByText('Use this location');
}

async function toConfirm(user: User): Promise<void> {
  await toBrowse(user);
  await user.click(screen.getByText('Use this location'));
  await screen.findByText('Confirm Setup');
}

function heading(): string {
  return screen.getByRole('heading', { level: 2 }).textContent;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('SetupWizard — AWS failures it recovers from', () => {
  it('offers an empty profile list, not a spinner, when the profiles cannot be read', async () => {
    const api = new WizardApi();
    vi.spyOn(api, 'listAwsProfiles').mockRejectedValue(new Error('~/.aws/config: parse error'));
    const { user } = renderWizard(api);
    await user.click(screen.getByLabelText('Set up from AWS'));
    expect(await screen.findByText('No AWS profiles found')).toBeDefined();
    expect(screen.queryByText('Loading profiles...')).toBeNull();
  });

  it.each([
    { reason: new Error('ExpiredToken: the security token included in the request is expired'), text: 'ExpiredToken: the security token included in the request is expired' },
    { reason: 'socket hang up', text: 'socket hang up' },
  ])('shows a bucket listing that threw, and lists again on Retry ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    const list = vi.spyOn(api, 'listS3Buckets').mockRejectedValueOnce(reason);
    const { user } = renderWizard(api);
    await user.click(screen.getByLabelText('Set up from AWS'));
    await user.click(await screen.findByRole('button', { name: 'default' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text);
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('my-cur-bucket')).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('filters a long bucket list', async () => {
    const api = new WizardApi();
    vi.spyOn(api, 'listS3Buckets').mockResolvedValue({
      buckets: ['acme-logs', 'acme-cur-prod', 'acme-cur-dev', 'acme-assets', 'acme-backups', 'acme-tmp'].map(name => ({ name, region: 'eu-west-1' })),
    });
    const { user } = renderWizard(api);
    await user.click(screen.getByLabelText('Set up from AWS'));
    await user.click(await screen.findByRole('button', { name: 'default' }));
    await user.type(await screen.findByPlaceholderText('Filter buckets...'), 'CUR');
    expect(screen.getByText('acme-cur-prod')).toBeDefined();
    expect(screen.getByText('acme-cur-dev')).toBeDefined();
    expect(screen.queryByText('acme-logs')).toBeNull();
  });

  it('browses on by hand when the team-config check throws', async () => {
    const api = new WizardApi();
    api.checkConfigBeacon = vi.fn<(params: CheckConfigBeaconParams) => Promise<CheckConfigBeaconResult>>().mockRejectedValue(new Error('AccessDenied'));
    const { user } = renderWizard(api);
    await toBucketStep(user);
    await user.click(screen.getByText('my-cur-bucket'));
    expect(await screen.findByText('Use this location')).toBeDefined();
  });

  it.each([
    { late: 'finds a config', settle: (d: ReturnType<typeof deferred<CheckConfigBeaconResult>>) => { d.resolve(FOUND); } },
    { late: 'fails', settle: (d: ReturnType<typeof deferred<CheckConfigBeaconResult>>) => { d.reject(new Error('late')); } },
  ])('lets a second pick win over a config check from the first that $late late', async ({ settle }) => {
    const api = new WizardApi();
    const first = deferred<CheckConfigBeaconResult>();
    const check = vi.fn<(params: CheckConfigBeaconParams) => Promise<CheckConfigBeaconResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ status: 'none' });
    api.checkConfigBeacon = check;
    const { user } = renderWizard(api);
    await toBucketStep(user);
    await user.click(screen.getByText('my-cur-bucket'));
    // The check is running; Next re-runs the pick.
    expect(screen.getByText('Loading buckets...')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Use this location')).toBeDefined();
    expect(check).toHaveBeenCalledTimes(2);
    const browsed = api.s3Browsed.length;

    // The first check lands late: it must not pull the user anywhere.
    await act(async () => { settle(first); await Promise.resolve(); });
    expect(screen.queryByText('Team configuration found')).toBeNull();
    expect(screen.getByText('Use this location')).toBeDefined();
    expect(api.s3Browsed).toHaveLength(browsed);
  });

  describe('the discovered team configuration', () => {
    async function toBeacon(api: WizardApi): Promise<User> {
      api.checkConfigBeacon = () => Promise.resolve(FOUND);
      const { user } = renderWizard(api);
      await toBucketStep(user);
      await user.click(screen.getByText('my-cur-bucket'));
      await screen.findByText('Team configuration found');
      return user;
    }

    it.each([
      { name: 'refused', arrange: (api: WizardApi) => { vi.spyOn(api, 'applyConfigBundle').mockResolvedValue({ status: 'error', message: 'Bundle targets an unknown schema version' }); }, text: 'Bundle targets an unknown schema version' },
      { name: 'thrown', arrange: (api: WizardApi) => { vi.spyOn(api, 'applyConfigBundle').mockRejectedValue(new Error('EACCES: config dir')); }, text: 'EACCES: config dir' },
      { name: 'thrown as a string', arrange: (api: WizardApi) => { vi.spyOn(api, 'applyConfigBundle').mockRejectedValue('disk full'); }, text: 'disk full' },
    ])('keeps the screen with the reason when applying it is $name', async ({ arrange, text }) => {
      const api = new WizardApi();
      arrange(api);
      const user = await toBeacon(api);
      await user.click(screen.getByRole('button', { name: 'Use this configuration' }));
      expect(await screen.findByText(text)).toBeDefined();
      expect(screen.getByRole('button', { name: 'Use this configuration' })).toHaveProperty('disabled', false);
    });

    it('shows Applying… while it is applied', async () => {
      const api = new WizardApi();
      vi.spyOn(api, 'applyConfigBundle').mockReturnValue(new Promise<never>(() => undefined));
      const user = await toBeacon(api);
      await user.click(screen.getByRole('button', { name: 'Use this configuration' }));
      expect(screen.getByRole('button', { name: 'Applying…' })).toHaveProperty('disabled', true);
    });

    it('goes back to the bucket list', async () => {
      const user = await toBeacon(new WizardApi());
      await user.click(screen.getByText('← Back'));
      expect(await screen.findByText('my-cur-bucket')).toBeDefined();
      expect(heading()).toBe('Daily FOCUS export');
    });
  });

  it('walks into folders and back out through the breadcrumbs', async () => {
    const api = new WizardApi();
    api.s3ByPrefix.set('', folder(['exports']));
    api.s3ByPrefix.set('exports/', folder(['daily']));
    api.s3ByPrefix.set('exports/daily/', BILLING_FOLDER);
    const { user } = renderWizard(api);
    await toBucketStep(user);
    await user.click(screen.getByText('my-cur-bucket'));
    await user.click(await screen.findByRole('button', { name: /exports\// }));
    await user.click(await screen.findByRole('button', { name: /daily\// }));
    expect(await screen.findByText('Use this location')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'exports' }));
    await screen.findByRole('button', { name: /daily\// });
    await user.click(screen.getByRole('button', { name: 'my-cur-bucket' }));
    await screen.findByRole('button', { name: /exports\// });
    expect(api.s3Browsed).toEqual(['', 'exports/', 'exports/daily/', 'exports/', '']);
  });

  it.each([
    { reason: new Error('SlowDown: please reduce your request rate'), text: 'SlowDown: please reduce your request rate' },
    { reason: 'connection reset', text: 'connection reset' },
  ])('shows a folder listing that threw, and lists it again on Retry ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    api.browseFailure = reason;
    const { user } = renderWizard(api);
    await toBucketStep(user);
    await user.click(screen.getByText('my-cur-bucket'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text);
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Use this location')).toBeDefined();
    expect(api.s3Browsed).toEqual(['', '']);
  });

  it('goes back from the folders to the bucket list', async () => {
    const { user } = renderWizard();
    await toBrowse(user);
    await user.click(screen.getByText('← Back'));
    expect(await screen.findByText('my-cur-bucket')).toBeDefined();
    expect(heading()).toBe('Daily FOCUS export');
  });
});

describe('SetupWizard — AWS optional tiers', () => {
  it('adds the hourly and Cost Optimization exports from Confirm', async () => {
    const { user } = renderWizard();
    await toConfirm(user);

    await user.click(screen.getByRole('button', { name: 'Add hourly export' }));
    await user.click(await screen.findByText('my-cur-bucket'));
    await user.click(await screen.findByText('Use this location'));
    expect(await screen.findByRole('group', { name: 'Hourly FOCUS export retention' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Add Cost Optimization data' }));
    await user.click(await screen.findByText('my-cur-bucket'));
    await user.click(await screen.findByText('Use this location'));
    expect(await screen.findByRole('group', { name: 'Cost Optimization retention' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
  });

  it('steps back through the tiers: Cost Optimization → hourly → daily', async () => {
    const { user } = renderWizard();
    await toConfirm(user);
    // ← Back on Confirm lands on the last optional tier.
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(heading()).toBe('Cost Optimization'); });
    await screen.findByText('my-cur-bucket');
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(heading()).toBe('Hourly FOCUS export'); });
    await screen.findByText('my-cur-bucket');
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(heading()).toBe('Daily FOCUS export'); });
  });

  it.each([
    { reason: new Error('costgoblin.yaml: EACCES'), text: 'costgoblin.yaml: EACCES' },
    { reason: 'ENOSPC', text: 'ENOSPC' },
  ])('shows why the config could not be written, and allows another try ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'writeConfig').mockRejectedValue(reason);
    const { user, onComplete } = renderWizard(api);
    await toConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Complete Setup' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Complete Setup' })).toHaveProperty('disabled', false);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('SetupWizard — create the exports, failures', () => {
  async function openCreate(api: WizardApi): Promise<User> {
    const { user } = renderWizard(api);
    await toBucketStep(user);
    await user.click(screen.getByRole('button', { name: 'Create one with CloudFormation' }));
    await screen.findByText('Create your AWS exports');
    return user;
  }

  it('returns to idle when saving the template is canceled', async () => {
    const api = new WizardApi();
    api.saveExportsTemplateResult = { status: 'canceled' };
    const user = await openCreate(api);
    await user.click(screen.getByRole('button', { name: 'Save the template…' }));
    await waitFor(() => { expect(api.savedExportsTemplates).toHaveLength(1); });
    expect(screen.getByRole('button', { name: 'Save the template…' })).toHaveProperty('disabled', false);
    expect(screen.queryByText(/^Saved to/)).toBeNull();
  });

  it.each([
    { reason: new Error('dialog crashed'), text: 'dialog crashed' },
    { reason: 'EPERM', text: 'EPERM' },
  ])('says why saving the template threw ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'saveExportsTemplate').mockRejectedValue(reason);
    const user = await openCreate(api);
    await user.click(screen.getByRole('button', { name: 'Save the template…' }));
    expect(await screen.findByText(new RegExp(text))).toBeDefined();
  });

  it('says why filing the backfill failed', async () => {
    const api = new WizardApi();
    api.backfillResult = { status: 'error', message: 'Support API: throttled' };
    const user = await openCreate(api);
    await user.click(screen.getByRole('button', { name: 'File it for me…' }));
    expect(await screen.findByText(/Support API: throttled/)).toBeDefined();
  });

  it.each([
    { reason: new Error('no credentials'), text: 'no credentials' },
    { reason: 'timeout', text: 'timeout' },
  ])('says why filing the backfill threw ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'fileBackfillCase').mockRejectedValue(reason);
    const user = await openCreate(api);
    await user.click(screen.getByRole('button', { name: 'File it for me…' }));
    expect(await screen.findByText(new RegExp(text))).toBeDefined();
  });
});

describe('SetupWizard — workspaces', () => {
  it('reports a renamed workspace when setup finishes, and no name when it was kept', async () => {
    const renamed = renderWizard(new WizardApi(), { workspaceNaming: { initialName: 'default' } });
    const input = screen.getByLabelText('Workspace name');
    await renamed.user.clear(input);
    await renamed.user.type(input, 'client-a');
    await renamed.user.click(screen.getByRole('button', { name: 'Continue' }));
    await renamed.user.click(screen.getByLabelText('Set up from AWS'));
    await renamed.user.click(await screen.findByText("Skip — I'll configure this manually"));
    expect(renamed.onComplete).toHaveBeenCalledWith({ workspaceName: 'client-a' });
    cleanup();

    const kept = renderWizard(new WizardApi(), { workspaceNaming: { initialName: 'default' } });
    await kept.user.click(screen.getByRole('button', { name: 'Continue' }));
    await kept.user.click(screen.getByLabelText('Set up from AWS'));
    await kept.user.click(await screen.findByText("Skip — I'll configure this manually"));
    expect(kept.onComplete).toHaveBeenCalledWith();
  });

  it.each([
    { reason: new Error('workspace "prod" is locked'), text: 'workspace "prod" is locked' },
    { reason: 'EBUSY', text: 'EBUSY' },
  ])('shows why jumping back to a workspace failed, and allows another try ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'switchWorkspace').mockRejectedValue(reason);
    const { user } = renderWizard(api, { otherWorkspaces: ['prod'] });
    await user.click(screen.getByRole('button', { name: 'prod' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.getByRole('button', { name: 'prod' })).toHaveProperty('disabled', false);
  });
});

describe('SetupWizard — GCP failures it recovers from', () => {
  const LAYOUT: Record<string, GcsBrowseResult> = {
    '': { prefixes: ['focus'], folder: { kind: 'unknown' }, hasParquet: false, truncated: false },
    'focus/': { prefixes: ['daily', 'hourly'], folder: { kind: 'tier-parent', tiers: ['daily', 'hourly'] }, hasParquet: false, truncated: false },
    'focus/daily/': { prefixes: ['billing_period=2026-07'], folder: { kind: 'export', periods: ['2026-07'] }, hasParquet: true, truncated: false },
    'focus/hourly/': { prefixes: ['billing_period=2026-07'], folder: { kind: 'export', periods: ['2026-07'] }, hasParquet: true, truncated: false },
  };

  async function toProjects(user: User): Promise<void> {
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
  }

  async function toGcpBucket(user: User): Promise<void> {
    await toProjects(user);
    await user.click(await screen.findByText('Acme Production'));
    await screen.findByText('acme-focus-export');
  }

  async function toGcpConfirm(user: User): Promise<void> {
    await toGcpBucket(user);
    await user.click(screen.getByText('acme-focus-export'));
    await user.click(await screen.findByLabelText('Open folder focus'));
    await user.click(await screen.findByLabelText('Open folder daily'));
    await user.click(await screen.findByText('Use this location'));
    await screen.findByText('Confirm Setup');
  }

  it.each([
    { reason: new Error('gcloud crashed'), text: 'gcloud crashed' },
    { reason: 'EPIPE', text: 'EPIPE' },
  ])('shows a project listing that threw ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'listGcpProjects').mockRejectedValue(reason);
    const { user } = renderWizard(api);
    await toProjects(user);
    expect((await screen.findByRole('alert')).textContent).toContain(text);
  });

  it('filters a long project list', async () => {
    const api = new WizardApi();
    api.gcpProjectsResult = { projects: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(id => ({ projectId: `acme-${id}`, name: `Acme ${id}` })) };
    const { user } = renderWizard(api);
    await toProjects(user);
    await user.type(await screen.findByPlaceholderText('Filter projects...'), 'eta');
    expect(screen.getByText('Acme beta')).toBeDefined();
    expect(screen.getByText('Acme zeta')).toBeDefined();
    expect(screen.queryByText('Acme alpha')).toBeNull();
  });

  it.each([
    { reason: new Error('Could not load the default credentials'), text: 'Could not load the default credentials' },
    { reason: 'ECONNREFUSED', text: 'ECONNREFUSED' },
  ])('lands on the bucket step with the reason when listing a typed project threw ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'listGcsBuckets').mockRejectedValue(reason);
    const { user } = renderWizard(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod{Enter}');
    expect((await screen.findByRole('alert')).textContent).toContain(text);
    expect(screen.getByLabelText('Or enter a bucket name directly')).toBeDefined();
  });

  it.each([
    { reason: new Error('quota exceeded'), text: 'quota exceeded' },
    { reason: 'ETIMEDOUT', text: 'ETIMEDOUT' },
  ])('shows a bucket listing that threw for a picked project ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'listGcsBuckets').mockRejectedValue(reason);
    const { user } = renderWizard(api);
    await toProjects(user);
    await user.click(await screen.findByText('Acme Production'));
    expect((await screen.findByRole('alert')).textContent).toContain(text);
  });

  it.each([
    { reason: new Error('storage.objects.list denied'), text: 'storage.objects.list denied' },
    { reason: 'EAI_AGAIN', text: 'EAI_AGAIN' },
  ])('shows a folder listing that threw ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    vi.spyOn(api, 'browseGcs').mockRejectedValue(reason);
    const { user } = renderWizard(api);
    await toGcpBucket(user);
    await user.click(screen.getByText('acme-focus-export'));
    expect((await screen.findByRole('alert')).textContent).toContain(text);
  });

  it('walks back out of folders through the breadcrumbs', async () => {
    const api = new WizardApi();
    api.gcsBrowseByPrefix = LAYOUT;
    const { user } = renderWizard(api);
    await toGcpBucket(user);
    await user.click(screen.getByText('acme-focus-export'));
    await user.click(await screen.findByLabelText('Open folder focus'));
    await user.click(await screen.findByLabelText('Open folder daily'));
    await screen.findByText('Use this location');

    await user.click(screen.getByRole('button', { name: 'focus' }));
    await screen.findByLabelText('Open folder daily');
    await user.click(screen.getByRole('button', { name: 'acme-focus-export' }));
    await screen.findByLabelText('Open folder focus');
    expect(api.gcsBrowsed.map(b => b.prefix)).toEqual(['', 'focus/', 'focus/daily/', 'focus/', '']);
  });

  it('goes back from the folders to the bucket step, and from hourly buckets to daily ones', async () => {
    const api = new WizardApi();
    api.gcsBrowseByPrefix = LAYOUT;
    const { user } = renderWizard(api);
    await toGcpBucket(user);
    await user.click(screen.getByText('acme-focus-export'));
    await screen.findByLabelText('Open folder focus');
    await user.click(screen.getByText('← Back'));
    expect(await screen.findByText('acme-focus-export')).toBeDefined();
    expect(heading()).toBe('Daily FOCUS export');
    cleanup();

    const again = new WizardApi();
    again.gcsBrowseByPrefix = LAYOUT;
    const second = renderWizard(again);
    await toGcpConfirm(second.user);
    await second.user.click(screen.getByRole('button', { name: 'Add hourly export' }));
    await screen.findByText('acme-focus-export');
    expect(heading()).toBe('Hourly FOCUS export');
    await second.user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(heading()).toBe('Daily FOCUS export'); });
  });

  it('offers the typed bucket entry when a per-tier Configure goes back from its folder', async () => {
    const api = new WizardApi();
    api.gcsBrowseByPrefix = LAYOUT;
    const list = vi.spyOn(api, 'listGcsBuckets');
    const { user } = renderWizard(api, { gcpSource: { bucket: 'acme-focus-export', prefix: 'focus/' } });
    await user.click(await screen.findByText('← Back'));
    expect(await screen.findByText('Enter the Cloud Storage bucket name')).toBeDefined();
    expect(screen.getByLabelText('Or enter a bucket name directly')).toBeDefined();
    // Without a project there is nothing to list buckets in.
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    { reason: new Error('gcloud storage ls: 403'), text: 'gcloud storage ls: 403' },
    { reason: 'spawn ENOENT', text: 'spawn ENOENT' },
  ])('holds the save when the download check itself throws ($text)', async ({ reason, text }) => {
    const api = new WizardApi();
    api.gcsBrowseByPrefix = LAYOUT;
    vi.spyOn(api, 'verifyGcsDownload').mockRejectedValue(reason);
    const { user } = renderWizard(api);
    await toGcpConfirm(user);
    expect(await screen.findByText(/so syncing it would fail/)).toBeDefined();
    expect(screen.getByText(text)).toBeDefined();
  });
});

describe('SetupWizard — a loader answering after the user left its step', () => {
  const START = 'Which cloud are you billing on?';
  const LOADERS: readonly { name: string; arrange: (api: WizardApi) => (outcome: Outcome) => void; open: (user: User) => Promise<void> }[] = [
    {
      name: 'the AWS profile listing',
      arrange: (api) => hold<Answer<'listAwsProfiles'>>((p) => { vi.spyOn(api, 'listAwsProfiles').mockReturnValue(p); }, ['default']),
      open: async (user) => { await user.click(screen.getByLabelText('Set up from AWS')); },
    },
    {
      name: 'the S3 bucket listing',
      arrange: (api) => hold<Answer<'listS3Buckets'>>((p) => { vi.spyOn(api, 'listS3Buckets').mockReturnValue(p); }, { buckets: [{ name: 'late-bucket', region: 'eu-west-1' }] }),
      open: async (user) => {
        await user.click(screen.getByLabelText('Set up from AWS'));
        await user.click(await screen.findByRole('button', { name: 'default' }));
      },
    },
    {
      name: 'the S3 folder listing',
      arrange: (api) => hold<S3Browse>((p) => { vi.spyOn(api, 'browseS3').mockReturnValue(p); }, BILLING_FOLDER),
      open: async (user) => {
        await toBucketStep(user);
        await user.click(screen.getByText('my-cur-bucket'));
      },
    },
    {
      name: 'the gcloud project listing',
      arrange: (api) => hold<Answer<'listGcpProjects'>>((p) => { vi.spyOn(api, 'listGcpProjects').mockReturnValue(p); }, { projects: [{ projectId: 'late-project', name: 'Late Project' }] }),
      open: async (user) => {
        await user.click(screen.getByLabelText('Set up from Google Cloud'));
        await user.click(screen.getByText('Choose from my projects'));
      },
    },
    {
      name: 'the bucket listing of a picked project',
      arrange: (api) => hold<Answer<'listGcsBuckets'>>((p) => { vi.spyOn(api, 'listGcsBuckets').mockReturnValue(p); }, { buckets: [{ name: 'late-bucket' }] }),
      open: async (user) => {
        await user.click(screen.getByLabelText('Set up from Google Cloud'));
        await user.click(screen.getByText('Choose from my projects'));
        await user.click(await screen.findByText('Acme Production'));
      },
    },
    {
      name: 'the bucket listing of a typed project',
      arrange: (api) => hold<Answer<'listGcsBuckets'>>((p) => { vi.spyOn(api, 'listGcsBuckets').mockReturnValue(p); }, { buckets: [{ name: 'late-bucket' }] }),
      open: async (user) => {
        await user.click(screen.getByLabelText('Set up from Google Cloud'));
        await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod{Enter}');
      },
    },
    {
      name: 'the Cloud Storage folder listing',
      arrange: (api) => hold<GcsBrowseResult>((p) => { vi.spyOn(api, 'browseGcs').mockReturnValue(p); }, { prefixes: ['late'], folder: { kind: 'unknown' }, hasParquet: false, truncated: false }),
      open: async (user) => {
        await user.click(screen.getByLabelText('Set up from Google Cloud'));
        await user.click(screen.getByText('Choose from my projects'));
        await user.click(await screen.findByText('Acme Production'));
        await user.click(await screen.findByText('acme-focus-export'));
      },
    },
    {
      name: 'the GCP config template',
      arrange: (api) => hold<undefined>((p) => { vi.spyOn(api, 'scaffoldConfig').mockReturnValue(p); }, undefined),
      open: async (user) => {
        await user.click(screen.getByLabelText('Set up from Google Cloud'));
        await user.click(screen.getByText('Write the config by hand instead'));
      },
    },
    {
      name: 'the CloudFormation template save',
      arrange: (api) => hold<Answer<'saveExportsTemplate'>>((p) => { vi.spyOn(api, 'saveExportsTemplate').mockReturnValue(p); }, { status: 'saved', path: '/late.yaml' }),
      open: async (user) => {
        await toBucketStep(user);
        await user.click(screen.getByRole('button', { name: 'Create one with CloudFormation' }));
        await user.click(await screen.findByRole('button', { name: 'Save the template…' }));
      },
    },
    {
      name: 'the hosted template link',
      arrange: (api) => hold<string | null>((p) => { vi.spyOn(api, 'getHostedExportsTemplateUrl').mockReturnValue(p); }, 'https://example.invalid/costgoblin-exports.yaml'),
      open: async (user) => {
        await toBucketStep(user);
        await user.click(screen.getByRole('button', { name: 'Create one with CloudFormation' }));
        await screen.findByText('Create your AWS exports');
      },
    },
    {
      name: 'the backfill filing',
      arrange: (api) => hold<Answer<'fileBackfillCase'>>((p) => { vi.spyOn(api, 'fileBackfillCase').mockReturnValue(p); }, { status: 'filed', caseId: 'late-case' }),
      open: async (user) => {
        await toBucketStep(user);
        await user.click(screen.getByRole('button', { name: 'Create one with CloudFormation' }));
        await user.click(await screen.findByRole('button', { name: 'File it for me…' }));
      },
    },
    {
      name: 'applying the team configuration',
      arrange: (api) => {
        api.checkConfigBeacon = () => Promise.resolve(FOUND);
        return hold<Answer<'applyConfigBundle'>>((p) => { vi.spyOn(api, 'applyConfigBundle').mockReturnValue(p); }, { status: 'error', message: 'late refusal' });
      },
      open: async (user) => {
        await toBucketStep(user);
        await user.click(screen.getByText('my-cur-bucket'));
        await user.click(await screen.findByRole('button', { name: 'Use this configuration' }));
      },
    },
  ];

  it.each(LOADERS.flatMap(loader => (['resolve', 'reject'] as const).map(outcome => ({ ...loader, outcome }))))(
    'stays on the start screen when $name settles late ($outcome)',
    async ({ arrange, open, outcome }) => {
      const api = new WizardApi();
      const settle = arrange(api);
      const { user, onComplete } = renderWizard(api);
      await open(user);
      await user.click(screen.getByLabelText('Back to start'));
      expect(screen.getByText(START)).toBeDefined();

      await act(async () => { settle(outcome); await Promise.resolve(); });
      expect(screen.getByText(START)).toBeDefined();
      expect(screen.queryByText(/late/i)).toBeNull();
      expect(onComplete).not.toHaveBeenCalled();
    },
  );
});

describe('SetupWizard — what the folder holds', () => {
  it('warns that a Cost Optimization report is no billing export', async () => {
    const api = new WizardApi();
    api.s3BrowseResult = { ...BILLING_FOLDER, detectedType: 'cost-optimization' };
    const { user } = renderWizard(api);
    await toBrowse(user);
    expect(screen.getByText('Data type mismatch')).toBeDefined();
    expect(screen.getByText(/This looks like a Cost Optimization report/)).toBeDefined();
    expect(screen.queryByText('FOCUS billing export detected')).toBeNull();
  });

  it('recognizes a Cost Optimization report in its own tier, and warns about a billing export there', async () => {
    const api = new WizardApi();
    const { user } = renderWizard(api);
    await toConfirm(user);

    api.s3BrowseResult = { ...BILLING_FOLDER, detectedType: 'cost-optimization' };
    await user.click(screen.getByRole('button', { name: 'Add Cost Optimization data' }));
    await user.click(await screen.findByText('my-cur-bucket'));
    expect(await screen.findByText('Cost Optimization report detected')).toBeDefined();
    expect(screen.queryByText('Data type mismatch')).toBeNull();

    api.s3BrowseResult = BILLING_FOLDER;
    await user.click(screen.getByText('← Back'));
    await user.click(await screen.findByText('my-cur-bucket'));
    expect(await screen.findByText(/This looks like a billing export, not a Cost Optimization export/)).toBeDefined();
  });

  it('confirms with every export the stack creates, Cost Optimization included', async () => {
    const { user } = renderWizard();
    await toBucketStep(user);
    await user.click(screen.getByRole('button', { name: 'Create one with CloudFormation' }));
    await user.click(await screen.findByLabelText(/Also export hourly data/));
    await user.click(screen.getByLabelText(/Also export Cost Optimization Hub recommendations/));
    await user.click(screen.getByRole('button', { name: 'Save the template…' }));
    await user.click(await screen.findByRole('button', { name: 'I’ve created the stack' }));
    expect(await screen.findByRole('group', { name: 'Hourly FOCUS export retention' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Cost Optimization retention' })).toBeDefined();
  });

  it('confirms with the daily export alone when the stack creates no other', async () => {
    const api = new WizardApi();
    const write = vi.spyOn(api, 'writeConfig');
    const { user } = renderWizard(api);
    await toBucketStep(user);
    await user.click(screen.getByRole('button', { name: 'Create one with CloudFormation' }));
    await user.click(await screen.findByRole('button', { name: 'Save the template…' }));
    await user.click(await screen.findByRole('button', { name: 'I’ve created the stack' }));
    expect(await screen.findByRole('group', { name: 'Daily FOCUS export retention' })).toBeDefined();
    expect(screen.queryByRole('group', { name: 'Hourly FOCUS export retention' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Complete Setup' }));
    await waitFor(() => { expect(write).toHaveBeenCalledTimes(1); });
    const written = write.mock.calls[0]?.[0];
    expect(written?.hourlyBucket).toBeUndefined();
    expect(written?.costOptBucket).toBeUndefined();
  });

  it('writes the Cost Optimization export with its own retention', async () => {
    const api = new WizardApi();
    const write = vi.spyOn(api, 'writeConfig');
    const { user } = renderWizard(api);
    await toConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Add Cost Optimization data' }));
    await user.click(await screen.findByText('my-cur-bucket'));
    await user.click(await screen.findByText('Use this location'));
    const retention = await screen.findByRole('group', { name: 'Cost Optimization retention' });
    await user.click(within(retention).getByRole('button', { name: '6 months' }));
    await user.click(screen.getByRole('button', { name: 'Complete Setup' }));
    await waitFor(() => { expect(write).toHaveBeenCalledTimes(1); });
    expect(write.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ costOptBucket: 's3://my-cur-bucket/', costOptRetentionDays: 180 }));
  });

  it('says when a folder holds no subfolders, on AWS and on Google Cloud', async () => {
    const aws = new WizardApi();
    aws.s3BrowseResult = folder([]);
    const first = renderWizard(aws);
    await toBucketStep(first.user);
    await first.user.click(screen.getByText('my-cur-bucket'));
    expect(await screen.findByText('No subfolders found')).toBeDefined();
    cleanup();

    const gcp = new WizardApi();
    gcp.gcsBrowseResult = { prefixes: [], folder: { kind: 'unknown' }, hasParquet: false, truncated: false };
    const second = renderWizard(gcp);
    await second.user.click(screen.getByLabelText('Set up from Google Cloud'));
    await second.user.click(screen.getByText('Choose from my projects'));
    await second.user.click(await screen.findByText('Acme Production'));
    await second.user.click(await screen.findByText('acme-focus-export'));
    expect(await screen.findByText('No subfolders found')).toBeDefined();
  });

  it('says when no project matches the filter', async () => {
    const api = new WizardApi();
    api.gcpProjectsResult = { projects: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(id => ({ projectId: `acme-${id}`, name: `Acme ${id}` })) };
    const { user } = renderWizard(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await user.type(await screen.findByPlaceholderText('Filter projects...'), 'nothing-like-it');
    expect(screen.getByText('No projects match that filter')).toBeDefined();
  });

  it('reports a config template failure that is not an Error', async () => {
    const api = new WizardApi();
    vi.spyOn(api, 'scaffoldConfig').mockRejectedValue('EROFS');
    const { user } = renderWizard(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Write the config by hand instead'));
    expect(await screen.findByText('EROFS')).toBeDefined();
  });

  it.each([
    { name: 'a Cost Optimization tier, which Google Cloud has not', props: { source: 'costOptimization' as const, gcpSource: { bucket: 'acme-focus-export', prefix: 'focus/' } } },
    { name: 'an AWS tier without a profile', props: { source: 'daily' as const } },
  ])('starts at the hub when asked to configure $name', ({ props }) => {
    render(
      <CostApiProvider value={new WizardApi()}>
        <SetupWizard onComplete={vi.fn()} {...props} />
      </CostApiProvider>,
    );
    expect(screen.getByText('Which cloud are you billing on?')).toBeDefined();
  });

  it('closes the teammate import without finishing setup', async () => {
    const { user, onComplete } = renderWizard();
    await user.click(screen.getByText('Import from a teammate'));
    const dialog = await screen.findByRole('dialog', { name: 'Import configuration' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Import configuration' })).toBeNull(); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});
