import { asBucketPath, asProviderName } from '@costgoblin/core/browser';
import type { CostGoblinConfig, DataSharingStatus, SharedPullProgress, SharedSourceInfo } from '@costgoblin/core/browser';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BundleSummaryCard, ImportConfigDialog, ImportConfigPanel, ShareConfigPanel } from '../components/config-sharing.js';
import { MOCK_BUNDLE_SUMMARY, MOCK_GCP_PROVIDER, MOCK_SHARED_SOURCE, MOCK_SHARED_SOURCE_PREVIEW, MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import type { Deferred } from './deferred.js';
import { deferred } from './deferred.js';

type ApplyResult = Awaited<ReturnType<MockCostApi['applyConfigBundle']>>;

const SHARING: DataSharingStatus = {
  enabled: true,
  sharingKey: 'CGSHARE1-live-key',
  label: 'Mock · CostGoblin',
  port: 53178,
  hosts: ['mock-peer.local'],
  fingerprint: 'ABCD-EF01-2345-6789',
  lastServedAt: null,
  filesServed: 0,
  lastPeer: null,
  bytesServed: 0,
  connectedClients: 0,
  bytesPerSecond: 0,
  autoStopsAt: null,
};

const GCP_ONLY: CostGoblinConfig = { providers: [MOCK_GCP_PROVIDER], defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 } };

function awsConfig(profile: string): CostGoblinConfig {
  return {
    providers: [{
      name: asProviderName('aws-main'),
      type: 'aws',
      credentialsProfile: profile,
      sync: { daily: { bucket: asBucketPath('costgoblin-cur-bucket/daily'), retentionDays: 90 }, intervalMinutes: 60 },
    }],
    defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
  };
}

function renderWith(api: MockCostApi, ui: React.JSX.Element) {
  const user = userEvent.setup();
  const view = render(<CostApiProvider value={api}>{ui}</CostApiProvider>);
  return { user, ...view };
}

function renderImport(api: MockCostApi, props: { onApplied?: () => void; onClose?: () => void } = {}) {
  return renderWith(api, <ImportConfigDialog onClose={props.onClose ?? vi.fn()} onApplied={props.onApplied ?? vi.fn()} />);
}

async function pasteKey(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('Sharing key from a teammate'), 'CGSHARE1-teammate');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

describe('BundleSummaryCard — counts', () => {
  it('uses the singular for one tag and one view, and leaves out empty sections', () => {
    render(<BundleSummaryCard summary={{ ...MOCK_BUNDLE_SUMMARY, tagDimensionCount: 1, viewCount: 1, orgTreeNodeCount: 0, exclusionRuleCount: 0 }} />);
    expect(screen.getByText('7 built-in + 1 tag')).toBeDefined();
    expect(screen.getByText('1 view')).toBeDefined();
    expect(screen.queryByText('Org tree')).toBeNull();
    expect(screen.queryByText('Cost scope')).toBeNull();
  });
});

describe('ShareConfigPanel — sharing on this network', () => {
  it.each([
    { status: { ...SHARING, lastServedAt: '2026-10-18T09:00:00Z', filesServed: 1 }, text: 'Last pull from a peer · 1 file served' },
    { status: { ...SHARING, lastServedAt: '2026-10-18T09:00:00Z', filesServed: 4, lastPeer: '192.168.1.20' }, text: 'Last pull from 192.168.1.20 · 4 files served' },
  ])('says who pulled last ($text)', async ({ status, text }) => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getDataSharingStatus').mockResolvedValue(status);
    renderWith(api, <ShareConfigPanel />);
    const line = await screen.findByText(text);
    expect(line.parentElement?.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('copies the sharing key, then resets the button', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new MockCostApi();
    vi.spyOn(api, 'getDataSharingStatus').mockResolvedValue(SHARING);
    const user = userEvent.setup({ advanceTimers: (ms) => { vi.advanceTimersByTime(ms); } });
    render(<CostApiProvider value={api}><ShareConfigPanel /></CostApiProvider>);

    await user.click(await screen.findByRole('button', { name: 'Copy key' }));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined();
    expect(await navigator.clipboard.readText()).toBe('CGSHARE1-live-key');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(screen.getByRole('button', { name: 'Copy key' })).toBeDefined();
  });

  it('rotates the key, and stops sharing with Stop', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getDataSharingStatus').mockResolvedValue(SHARING);
    const rotate = vi.spyOn(api, 'rotateDataSharingKey');
    const stopping = deferred<Awaited<ReturnType<MockCostApi['disableDataSharing']>>>();
    vi.spyOn(api, 'disableDataSharing').mockReturnValue(stopping.promise);
    const { user } = renderWith(api, <ShareConfigPanel />);

    await user.click(await screen.findByRole('button', { name: /Rotate \(revokes old key\)/ }));
    expect(rotate).toHaveBeenCalledTimes(1);
    await waitFor(() => { expect(screen.getByLabelText('Sharing key')).toHaveProperty('value', 'CGSHARE1-rotated-key'); });

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toHaveProperty('disabled', true);
    await act(async () => { stopping.resolve({ status: 'ok', sharing: { ...SHARING, enabled: false, sharingKey: null } }); await Promise.resolve(); });
    expect(await screen.findByRole('button', { name: 'Start sharing' })).toBeDefined();
    expect(screen.queryByLabelText('Sharing key')).toBeNull();
  });

  it.each([
    { name: 'a refusal', arrange: (api: MockCostApi) => { vi.spyOn(api, 'enableDataSharing').mockResolvedValue({ status: 'error', message: 'No network interface to share on' }); }, text: 'No network interface to share on' },
    { name: 'a thrown Error', arrange: (api: MockCostApi) => { vi.spyOn(api, 'enableDataSharing').mockRejectedValue(new Error('EADDRINUSE')); }, text: 'EADDRINUSE' },
    { name: 'a thrown string', arrange: (api: MockCostApi) => { vi.spyOn(api, 'enableDataSharing').mockRejectedValue('firewall blocked'); }, text: 'firewall blocked' },
  ])('says why sharing did not start ($name)', async ({ arrange, text }) => {
    const api = new MockCostApi();
    arrange(api);
    const { user } = renderWith(api, <ShareConfigPanel />);
    await user.click(await screen.findByRole('button', { name: 'Start sharing' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Start sharing' })).toHaveProperty('disabled', false);
  });
});

describe('ShareConfigPanel — export and publish failures', () => {
  it.each([
    { name: 'a refusal', arrange: (api: MockCostApi) => { vi.spyOn(api, 'exportConfigBundle').mockResolvedValue({ status: 'error', message: 'EACCES: Downloads is read-only' }); }, text: 'EACCES: Downloads is read-only' },
    { name: 'a thrown Error', arrange: (api: MockCostApi) => { vi.spyOn(api, 'exportConfigBundle').mockRejectedValue(new Error('dialog crashed')); }, text: 'dialog crashed' },
    { name: 'a thrown string', arrange: (api: MockCostApi) => { vi.spyOn(api, 'exportConfigBundle').mockRejectedValue('no window'); }, text: 'no window' },
  ])('reports an export that failed ($name)', async ({ arrange, text }) => {
    const api = new MockCostApi();
    arrange(api);
    const { user } = renderWith(api, <ShareConfigPanel />);
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.queryByText(/^Saved to/)).toBeNull();
  });

  it('says nothing when the save dialog is canceled', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'exportConfigBundle').mockResolvedValue({ status: 'canceled' });
    const { user } = renderWith(api, <ShareConfigPanel />);
    await user.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Export…' })).toHaveProperty('disabled', false); });
    expect(screen.queryByText(/^Saved to/)).toBeNull();
  });

  it.each([
    { reason: new Error('AccessDenied: s3:PutObject'), text: 'AccessDenied: s3:PutObject' },
    { reason: 'socket hang up', text: 'socket hang up' },
  ])('reports a publish that threw ($text)', async ({ reason, text }) => {
    const api = new MockCostApi();
    vi.spyOn(api, 'publishConfigBundle').mockRejectedValue(reason);
    const { user } = renderWith(api, <ShareConfigPanel />);
    const input = await screen.findByLabelText('Destination');
    await waitFor(() => { expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml'); });
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(text)).toBeDefined();
  });

  it('publishes without naming a profile when no AWS provider is configured', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue(GCP_ONLY);
    const publish = vi.spyOn(api, 'publishConfigBundle');
    const { user } = renderWith(api, <ShareConfigPanel />);
    const input = await screen.findByLabelText('Destination');
    // A GCP bucket is no S3 beacon location: nothing to suggest.
    await waitFor(() => { expect(input).toHaveProperty('disabled', false); });
    expect(input).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true);

    await user.type(input, 's3://team-bucket/costgoblin/org-config.yaml');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => { expect(publish).toHaveBeenCalledWith({ location: 's3://team-bucket/costgoblin/org-config.yaml' }); });
  });

  it('keeps a publish profile picked while the config was still loading', async () => {
    const api = new MockCostApi();
    const config = deferred<CostGoblinConfig>();
    vi.spyOn(api, 'getConfig').mockReturnValue(config.promise);
    const publish = vi.spyOn(api, 'publishConfigBundle');
    const { user } = renderWith(api, <ShareConfigPanel />);
    await user.click(await screen.findByRole('button', { name: 'staging' }));
    await act(async () => { config.resolve(awsConfig('default')); await Promise.resolve(); });

    const input = screen.getByLabelText('Destination');
    await waitFor(() => { expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml'); });
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => { expect(publish).toHaveBeenCalledWith({ location: 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml', profile: 'staging' }); });
  });

  it('leaves the destination empty and editable when the config cannot be read', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockRejectedValue(new Error('no config'));
    const { user } = renderWith(api, <ShareConfigPanel />);
    const input = await screen.findByLabelText('Destination');
    await waitFor(() => { expect(input).toHaveProperty('disabled', false); });
    await user.type(input, 's3://team-bucket/costgoblin/org-config.yaml');
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', false);
  });
});

describe('ImportConfigDialog — pull from a teammate, beyond the happy path', () => {
  it('follows the pull through connecting, downloading and importing, then reports it in the singular', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new MockCostApi();
    const pull = deferred<Awaited<ReturnType<MockCostApi['addSharedSource']>>>();
    api.addSharedSource = () => pull.promise;
    let progress: SharedPullProgress = { active: true, phase: 'connecting', filesDone: 0, filesTotal: 0, currentPeriod: null, bytesDone: 0, bytesTotal: 0, error: null };
    vi.spyOn(api, 'getSharedPullProgress').mockImplementation(() => Promise.resolve(progress));
    const onApplied = vi.fn();
    const user = userEvent.setup({ advanceTimers: (ms) => { vi.advanceTimersByTime(ms); } });
    render(<CostApiProvider value={api}><ImportConfigDialog onClose={vi.fn()} onApplied={onApplied} /></CostApiProvider>);
    const tick = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); };

    await pasteKey(user);
    await user.click(await screen.findByRole('button', { name: 'Pull' }));
    expect(screen.getByText('Connecting…')).toBeDefined();
    await tick();
    expect(screen.getByText('Connecting…')).toBeDefined();
    // Nothing sized yet: no bar.
    expect(screen.queryByText(/ files/)).toBeNull();

    progress = { ...progress, phase: 'downloading', filesDone: 2, filesTotal: 5, currentPeriod: '2026-05', bytesDone: 50, bytesTotal: 200 };
    await tick();
    expect(screen.getByText('Downloading…')).toBeDefined();
    expect(screen.getByText('50 B / 200 B · 2/5 files · 2026-05')).toBeDefined();
    const bar = document.querySelector('.h-1\\.5 > div');
    if (!(bar instanceof HTMLElement)) throw new Error('progress bar missing');
    expect(bar.style.width).toBe('25%');

    progress = { ...progress, phase: 'importing', filesDone: 5, currentPeriod: null, bytesDone: 200 };
    await tick();
    expect(screen.getByText('Importing…')).toBeDefined();
    expect(screen.getByText('200 B / 200 B · 5/5 files')).toBeDefined();

    const source: SharedSourceInfo = { ...MOCK_SHARED_SOURCE, periods: ['2026-06'] };
    await act(async () => { pull.resolve({ status: 'ok', source, filesDownloaded: 1 }); await Promise.resolve(); });
    expect(await screen.findByText(`Pulled 1 file from ${source.label} · 1 period.`)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('picks all or no months, and takes a tier back after dropping it', async () => {
    const api = new MockCostApi();
    const add = vi.spyOn(api, 'addSharedSource');
    const { user } = renderImport(api);
    await pasteKey(user);
    await user.click(await screen.findByRole('button', { name: 'None' }));
    for (const month of ['2026-04', '2026-05', '2026-06']) {
      expect(screen.getByRole('button', { name: month }).className).not.toContain('border-accent');
    }
    await user.click(screen.getByRole('button', { name: 'All' }));
    for (const month of ['2026-04', '2026-05', '2026-06']) {
      expect(screen.getByRole('button', { name: month }).className).toContain('border-accent');
    }
    const hourly = screen.getByRole('button', { name: /^Hourly billing data/ });
    await user.click(hourly);
    expect(hourly.className).not.toContain('border-accent');
    await user.click(hourly);
    expect(hourly.className).toContain('border-accent');

    await user.click(screen.getByRole('button', { name: 'Pull' }));
    await waitFor(() => { expect(add).toHaveBeenCalled(); });
    const selection = add.mock.calls[0]?.[1];
    expect(selection?.sources).toContain('hourly');
    expect(selection?.periods).toEqual(['2026-04', '2026-05', '2026-06']);
  });

  it('cannot pull data with no month picked unless Configuration is ticked', async () => {
    const { user } = renderImport(new MockCostApi());
    await pasteKey(user);
    await user.click(await screen.findByRole('button', { name: 'None' }));
    // Configuration alone is still something to pull.
    expect(screen.getByRole('button', { name: 'Pull' })).toHaveProperty('disabled', false);
    await user.click(screen.getByLabelText(/Configuration/));
    expect(screen.getByRole('button', { name: 'Pull' })).toHaveProperty('disabled', true);
  });

  it.each([
    { name: 'a refusal', arrange: (api: MockCostApi) => { api.previewSharedSource = () => Promise.resolve({ status: 'error', message: 'Teammate is not sharing right now' }); }, text: 'Teammate is not sharing right now' },
    { name: 'a thrown Error', arrange: (api: MockCostApi) => { vi.spyOn(api, 'previewSharedSource').mockRejectedValue(new Error('TLS handshake failed')); }, text: 'TLS handshake failed' },
    { name: 'a thrown string', arrange: (api: MockCostApi) => { vi.spyOn(api, 'previewSharedSource').mockRejectedValue('EHOSTUNREACH'); }, text: 'EHOSTUNREACH' },
  ])('stays on the key entry with why the teammate could not be reached ($name)', async ({ arrange, text }) => {
    const api = new MockCostApi();
    arrange(api);
    const { user } = renderImport(api);
    await pasteKey(user);
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.getByLabelText('Sharing key from a teammate')).toHaveProperty('value', 'CGSHARE1-teammate');
  });

  it('offers Retry and Start over when a pull fails', async () => {
    const api = new MockCostApi();
    const add = vi.spyOn(api, 'addSharedSource').mockResolvedValue({ status: 'error', message: 'Connection reset by peer' });
    const { user } = renderImport(api);
    await pasteKey(user);
    await user.click(await screen.findByRole('button', { name: 'Pull' }));
    expect(await screen.findByText('Connection reset by peer')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => { expect(add).toHaveBeenCalledTimes(2); });
    expect(add.mock.calls[1]?.[0]).toBe('CGSHARE1-teammate');
    expect(await screen.findByText('Connection reset by peer')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByLabelText('Sharing key from a teammate')).toBeDefined();
    expect(screen.queryByText('Connection reset by peer')).toBeNull();
  });

  it.each([
    { reason: new Error('peer closed the stream'), text: 'peer closed the stream' },
    { reason: 'ECONNRESET', text: 'ECONNRESET' },
  ])('reports a pull that threw ($text)', async ({ reason, text }) => {
    const api = new MockCostApi();
    vi.spyOn(api, 'addSharedSource').mockRejectedValue(reason);
    const { user } = renderImport(api);
    await pasteKey(user);
    await user.click(await screen.findByRole('button', { name: 'Pull' }));
    expect(await screen.findByText(text)).toBeDefined();
  });

  it.each([
    { enrichment: { accounts: 0, regions: 5 }, hint: 'Also replaces your account & region names (5 regions)' },
    { enrichment: { accounts: 0, regions: 0 }, hint: 'Also replaces your account & region names' },
  ])('words the names it would replace without a zero count ($hint)', async ({ enrichment, hint }) => {
    const api = new MockCostApi();
    api.previewSharedSource = () => Promise.resolve({ status: 'ok', preview: { ...MOCK_SHARED_SOURCE_PREVIEW, enrichment } });
    const { user } = renderImport(api);
    await pasteKey(user);
    expect(await screen.findByText(hint)).toBeDefined();
  });

  it('goes back from choosing to the key entry', async () => {
    const { user } = renderImport(new MockCostApi());
    await pasteKey(user);
    await user.click(await screen.findByRole('button', { name: '← Back' }));
    expect(screen.getByLabelText('Sharing key from a teammate')).toBeDefined();
  });

  it('forgets a saved teammate it never pulled from', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getSharedSource').mockResolvedValue({ ...MOCK_SHARED_SOURCE, lastPulledAt: null });
    const remove = vi.spyOn(api, 'removeSharedSource');
    const { user } = renderImport(api);
    expect(await screen.findByText(/^Saved source · fingerprint/)).toBeDefined();
    expect(screen.getByLabelText('Or a key from someone else')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Forget this teammate' }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText('Sharing key from a teammate')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Reconnect/ })).toBeNull();
  });
});

describe('ImportConfigPanel — bundles from a file or S3', () => {
  it('applies under the default profile when no profile or config can be read', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'listAwsProfiles').mockRejectedValue(new Error('~/.aws missing'));
    vi.spyOn(api, 'getConfig').mockRejectedValue(new Error('no config'));
    const apply = vi.spyOn(api, 'applyConfigBundle');
    const { user } = renderImport(api);
    expect(screen.getByRole('button', { name: 'Fetch from S3' })).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Apply configuration' }));
    await waitFor(() => { expect(apply).toHaveBeenCalledWith({ content: 'kind: costgoblin-config-bundle', credentialsProfile: 'default' }); });
  });

  it('defaults the fetch to "default" with no profiles, and offers no beacon without an AWS provider', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'listAwsProfiles').mockResolvedValue([]);
    vi.spyOn(api, 'getConfig').mockResolvedValue(GCP_ONLY);
    const apply = vi.spyOn(api, 'applyConfigBundle');
    const { user } = renderImport(api);
    await waitFor(() => { expect(screen.getByLabelText('S3 location')).toHaveProperty('value', ''); });
    expect(screen.getByRole('button', { name: 'Fetch from S3' })).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Apply configuration' }));
    await waitFor(() => { expect(apply).toHaveBeenCalledWith(expect.objectContaining({ credentialsProfile: 'default' })); });
  });

  it('keeps the profile and location the user chose while the config was loading', async () => {
    const api = new MockCostApi();
    const config = deferred<CostGoblinConfig>();
    vi.spyOn(api, 'getConfig').mockReturnValue(config.promise);
    const fetchBundle = vi.spyOn(api, 'fetchConfigBundleFromS3');
    const { user } = renderImport(api);

    await user.click(await screen.findByRole('button', { name: 'staging' }));
    await user.type(screen.getByLabelText('S3 location'), 's3://mine/costgoblin/org-config.yaml');
    await act(async () => { config.resolve(awsConfig('default')); await Promise.resolve(); });

    expect(screen.getByLabelText('S3 location')).toHaveProperty('value', 's3://mine/costgoblin/org-config.yaml');
    await user.click(screen.getByRole('button', { name: 'Fetch from S3' }));
    await waitFor(() => { expect(fetchBundle).toHaveBeenCalledWith({ profile: 'staging', location: 's3://mine/costgoblin/org-config.yaml' }); });
  });

  it('keeps the configured profile when the profile list arrives after the config', async () => {
    const api = new MockCostApi();
    const profiles = deferred<string[]>();
    vi.spyOn(api, 'listAwsProfiles').mockReturnValue(profiles.promise);
    vi.spyOn(api, 'getConfig').mockResolvedValue(awsConfig('prod'));
    const fetchBundle = vi.spyOn(api, 'fetchConfigBundleFromS3');
    const { user } = renderImport(api);
    const input = await screen.findByLabelText('S3 location');
    await waitFor(() => { expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml'); });
    await act(async () => { profiles.resolve(['default', 'prod', 'staging']); await Promise.resolve(); });

    await user.click(await screen.findByRole('button', { name: 'Fetch from S3' }));
    await waitFor(() => { expect(fetchBundle).toHaveBeenCalledWith({ profile: 'prod', location: 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml' }); });
  });

  it.each([
    { name: 'refused', settle: (d: Deferred<ApplyResult>) => { d.resolve({ status: 'error', message: 'late refusal' }); }, text: 'late refusal' },
    { name: 'thrown', settle: (d: Deferred<ApplyResult>) => { d.reject(new Error('late failure')); }, text: 'late failure' },
  ])('stays on the picker when an apply cancelled mid-flight is $name', async ({ settle, text }) => {
    const api = new MockCostApi();
    const apply = deferred<ApplyResult>();
    vi.spyOn(api, 'applyConfigBundle').mockReturnValue(apply.promise);
    const { user } = renderWith(api, <ImportConfigPanel onApplied={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Apply configuration' }));
    expect(screen.getByRole('button', { name: 'Applying…' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Choose bundle file…' })).toBeDefined();

    await act(async () => { settle(apply); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Choose bundle file…' })).toBeDefined();
    expect(screen.queryByText(text)).toBeNull();
  });

  it.each([
    { reason: new Error('EISDIR: not a file'), text: 'EISDIR: not a file' },
    { reason: 'dialog failed', text: 'dialog failed' },
  ])('reports a bundle file it could not read ($text)', async ({ reason, text }) => {
    const api = new MockCostApi();
    vi.spyOn(api, 'previewConfigBundleFile').mockRejectedValue(reason);
    const { user } = renderImport(api);
    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Choose bundle file…' })).toBeDefined();
  });

  it('stays on the picker without an error when the S3 fetch is canceled', async () => {
    const api = new MockCostApi();
    api.fetchConfigBundleFromS3 = () => Promise.resolve({ status: 'canceled' });
    const { user } = renderImport(api);
    const input = await screen.findByLabelText('S3 location');
    await waitFor(() => { expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml'); });
    await user.click(screen.getByRole('button', { name: 'Fetch from S3' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Fetch from S3' })).toHaveProperty('disabled', false); });
    expect(screen.queryByRole('button', { name: 'Apply configuration' })).toBeNull();
  });

  it.each([
    { reason: new Error('ExpiredToken'), text: 'ExpiredToken' },
    { reason: 'timeout', text: 'timeout' },
  ])('reports an S3 fetch that threw ($text)', async ({ reason, text }) => {
    const api = new MockCostApi();
    vi.spyOn(api, 'fetchConfigBundleFromS3').mockRejectedValue(reason);
    const { user } = renderImport(api);
    const input = await screen.findByLabelText('S3 location');
    await waitFor(() => { expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml'); });
    await user.click(screen.getByRole('button', { name: 'Fetch from S3' }));
    expect(await screen.findByText(text)).toBeDefined();
  });

  it.each([
    { reason: new Error('backup failed: disk full'), text: 'backup failed: disk full' },
    { reason: 'EROFS', text: 'EROFS' },
  ])('keeps the preview with the error when applying throws ($text)', async ({ reason, text }) => {
    const api = new MockCostApi();
    vi.spyOn(api, 'applyConfigBundle').mockRejectedValue(reason);
    const { user } = renderImport(api);
    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Apply configuration' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Apply configuration' })).toHaveProperty('disabled', false);
  });

  it('says where the previous configuration was backed up', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'applyConfigBundle').mockResolvedValue({ status: 'applied', sections: ['config'], backupDir: '/Users/me/.costgoblin/backups/2026-10-18' });
    const { user } = renderImport(api);
    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Apply configuration' }));
    expect(await screen.findByText('Your previous configuration was backed up to /Users/me/.costgoblin/backups/2026-10-18')).toBeDefined();
  });

  it('Cancel on the preview closes the dialog it sits in', async () => {
    const onClose = vi.fn();
    const { user } = renderImport(new MockCostApi(), { onClose });
    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel on an inline preview goes back to choosing a bundle', async () => {
    const { user } = renderWith(new MockCostApi(), <ImportConfigPanel onApplied={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    const dialogless = await screen.findByRole('button', { name: 'Cancel' });
    expect(within(document.body).queryByRole('dialog')).toBeNull();
    await user.click(dialogless);
    expect(await screen.findByRole('button', { name: 'Choose bundle file…' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Apply configuration' })).toBeNull();
  });
});
