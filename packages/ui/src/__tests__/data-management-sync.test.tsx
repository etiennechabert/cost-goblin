import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asBucketPath, asProviderName } from '@costgoblin/core/browser';
import type { AwsProviderConfig, CostGoblinConfig, DataInventoryResult, DataTier, GcpProviderConfig, ProviderConfig, SyncStatus } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DataManagement } from '../views/data-management.js';
import { deferred, rejectWith } from './deferred.js';

type Period = DataInventoryResult['periods'][number];

function period(name: string, localStatus: Period['localStatus'], size = 1024, files = 1): Period {
  return {
    period: name,
    localStatus,
    totalSize: size,
    files: Array.from({ length: files }, (_, i) => ({ key: `${name}/part-${String(i)}.parquet`, contentHash: `h-${name}-${String(i)}`, size: size / files })),
  };
}

function inventory(periods: readonly Period[], local: readonly string[] = []): DataInventoryResult {
  return {
    periods,
    totalRemoteSize: periods.reduce((s, p) => s + p.totalSize, 0),
    totalLocalPeriods: local.length,
    totalRemotePeriods: periods.length,
    lastSync: null,
    local: { periods: local, diskBytes: 4096, oldestPeriod: local[0] ?? null, newestPeriod: local.at(-1) ?? null },
  };
}

const AWS_FULL: AwsProviderConfig = {
  name: asProviderName('aws-main'),
  type: 'aws',
  credentialsProfile: 'default',
  sync: {
    daily: { bucket: asBucketPath('acme-cur/daily'), retentionDays: 90 },
    hourly: { bucket: asBucketPath('acme-cur/hourly'), retentionDays: 30 },
    costOptimization: { bucket: asBucketPath('acme-cur/cost-opt'), retentionDays: 90 },
    intervalMinutes: 60,
  },
};

function configOf(...providers: ProviderConfig[]): CostGoblinConfig {
  return { providers, defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 } };
}

type InventoryAnswer = DataInventoryResult | { readonly fail: unknown } | 'pending';

const IDLE: SyncStatus = { status: 'idle', lastSync: null };

function downloadingStatus(filesDone: number, filesTotal: number): SyncStatus {
  return { status: 'syncing', phase: 'downloading', progress: 0, filesDone, filesTotal, bytesDone: 0, bytesTotal: 0, message: '' };
}

/** Per-(provider, tier) inventories and server-side sync statuses, keyed by
 *  the composite syncId the page uses (`{provider}:{tier}`). */
class DmApi extends MockCostApi {
  config: CostGoblinConfig = configOf(AWS_FULL);
  readonly inventories = new Map<string, InventoryAnswer>();
  readonly statuses = new Map<string, SyncStatus>();
  inventoryReads = 0;
  configReads = 0;

  constructor() {
    super();
    this.getSyncStatus = (syncId) => Promise.resolve(this.statuses.get(syncId ?? '') ?? IDLE);
  }

  override getConfig(): Promise<CostGoblinConfig> {
    this.configReads += 1;
    return Promise.resolve(this.config);
  }

  override getDataInventory(tier?: DataTier, providerName?: string): Promise<DataInventoryResult> {
    this.inventoryReads += 1;
    const answer = this.inventories.get(`${String(providerName)}:${String(tier)}`) ?? inventory([]);
    if (answer === 'pending') return new Promise<DataInventoryResult>(() => undefined);
    if ('fail' in answer) {
      return rejectWith(answer.fail);
    }
    return Promise.resolve(answer);
  }
}

function renderDm(api: DmApi) {
  const user = userEvent.setup();
  const view = render(
    <CostApiProvider value={api}>
      <DataManagement />
    </CostApiProvider>,
  );
  return { user, ...view };
}

async function tierPanel(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title, level: 3 });
  const panel = heading.closest('div.flex-1');
  if (!(panel instanceof HTMLElement)) throw new Error(`no ${title} panel`);
  return panel;
}

/** Waits out an inventory re-read and returns the tier panel drawn after it,
 *  once it lists `month` again. While the daily inventory reloads the page
 *  shows its loading line in place of every tier panel, so the panel found
 *  before a refresh is a detached copy once it is done. The hourly and Cost
 *  Optimization inventories reload behind no loading line: until theirs lands
 *  the panel shows its empty state, so the month is what says it is back. */
async function afterInventoryRefresh(api: DmApi, readsBefore: number, title: string, month: string): Promise<HTMLElement> {
  await waitFor(() => { expect(api.inventoryReads).toBeGreaterThan(readsBefore); });
  await waitFor(() => { expect(screen.queryByText('Checking S3 for available data...')).toBeNull(); });
  const panel = await tierPanel(title);
  await within(panel).findByText(month);
  return panel;
}

function monthCheckbox(panel: HTMLElement, month: string): HTMLElement {
  const row = within(panel).getByText(month).closest('label');
  if (row === null) throw new Error(`no ${month} row`);
  return within(row).getByRole('checkbox');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanup();
});

const TIERS: readonly { title: string; tier: DataTier; label: string }[] = [
  { title: 'Daily', tier: 'daily', label: 'daily' },
  { title: 'Hourly', tier: 'hourly', label: 'hourly' },
  { title: 'Cost Optimization', tier: 'cost-optimization', label: 'cost optimization' },
];

describe('DataManagement — each tier of a provider', () => {
  it.each(TIERS)('picks, deletes, downloads, cancels and retries $title months', async ({ title, tier, label }) => {
    const api = new DmApi();
    for (const t of TIERS) {
      api.inventories.set(`aws-main:${t.tier}`, inventory([period('2099-12', 'missing', 2048), period('2099-11', 'stale'), period('2026-01', 'repartitioned', 512)], ['2026-01']));
    }
    const syncId = `aws-main:${tier}`;
    const { user } = renderDm(api);
    let panel = await tierPanel(title);

    // Only months never downloaded start ticked — a stale one waits to be picked.
    expect(await within(panel).findByRole('button', { name: 'Download 1 (2.0KB)' })).toBeDefined();
    await user.click(monthCheckbox(panel, 'Nov 2099'));
    expect(within(panel).getByRole('button', { name: 'Download 2 (3.0KB)' })).toBeDefined();
    await user.click(monthCheckbox(panel, 'Dec 2099'));
    expect(within(panel).getByRole('button', { name: 'Download 1 (1.0KB)' })).toBeDefined();
    await user.click(within(panel).getByRole('button', { name: 'None' }));
    expect(within(panel).queryByRole('button', { name: /^Download/ })).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'All' }));
    expect(within(panel).getByRole('button', { name: 'Download 1 (2.0KB)' })).toBeDefined();

    // A downloaded month is deleted from this tier only, after confirming,
    // and the tier's inventory is read again.
    const remove = vi.spyOn(api, 'deleteLocalPeriod');
    await user.click(within(panel).getByRole('button', { name: '✕' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete local data' });
    let reads = api.inventoryReads;
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => { expect(remove).toHaveBeenCalledWith('2026-01', tier, 'aws-main'); });
    panel = await afterInventoryRefresh(api, reads, title, 'Dec 2099');

    // A run the user cancels: the backend reports it syncing until cancelled.
    const first = deferred<{ filesDownloaded: number; rowsProcessed: number }>();
    const sync = vi.spyOn(api, 'syncPeriods').mockImplementation((_files, id) => {
      api.statuses.set(id ?? '', downloadingStatus(0, 1));
      return first.promise;
    });
    const cancel = vi.spyOn(api, 'cancelSync').mockImplementation((id) => {
      api.statuses.set(id ?? '', IDLE);
      return Promise.resolve();
    });
    await user.click(within(panel).getByRole('button', { name: 'Download 1 (2.0KB)' }));
    expect(sync).toHaveBeenCalledWith([expect.objectContaining({ key: '2099-12/part-0.parquet' })], syncId);
    expect(within(panel).getByText(/^Downloading 0\/1 files/)).toBeDefined();
    await user.click(within(panel).getByTitle('Cancel download'));
    expect(cancel).toHaveBeenCalledWith(syncId);
    expect(within(panel).queryByText(/^Downloading/)).toBeNull();
    await act(async () => { first.reject(new Error('Sync cancelled')); await Promise.resolve(); });
    expect(await within(panel).findByText('Sync cancelled')).toBeDefined();

    // Retried, it completes: the panel reports it and re-reads the inventory.
    // (The backend is not reported syncing this time, so the 2 s status poll
    // never adds a second refresh to wait for.)
    const second = deferred<{ filesDownloaded: number; rowsProcessed: number }>();
    sync.mockReturnValue(second.promise);
    await user.click(within(panel).getByRole('button', { name: 'Download 1 (2.0KB)' }));
    reads = api.inventoryReads;
    await act(async () => { second.resolve({ filesDownloaded: 1, rowsProcessed: 12 }); await Promise.resolve(); });
    panel = await afterInventoryRefresh(api, reads, title, 'Dec 2099');
    expect(within(panel).getByText('Synced 1 files')).toBeDefined();
    // The downloaded selection is cleared rather than offered again.
    expect(within(panel).queryByRole('button', { name: /^Download/ })).toBeNull();

    // Each tier's gear opens the wizard on that tier alone.
    await user.click(within(panel).getByTitle(`Configure ${title.toLowerCase()}`));
    const wizard = await screen.findByRole('dialog', { name: `Configure ${label} data source for aws-main` });
    await user.click(within(wizard).getByRole('button', { name: 'Close' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('starts no download for a selection whose months list no files', async () => {
    const api = new DmApi();
    api.inventories.set('aws-main:daily', inventory([period('2099-12', 'missing', 0, 0)]));
    const sync = vi.spyOn(api, 'syncPeriods');
    const { user } = renderDm(api);
    const panel = await tierPanel('Daily');
    await user.click(await within(panel).findByRole('button', { name: 'Download 1 (0B)' }));
    expect(sync).not.toHaveBeenCalled();
    expect(within(panel).queryByText(/^Downloading/)).toBeNull();
  });

  it('reports a download that fails with something other than an Error', async () => {
    const api = new DmApi();
    api.inventories.set('aws-main:daily', inventory([period('2099-12', 'missing')]));
    vi.spyOn(api, 'syncPeriods').mockReturnValue(rejectWith('aws exited 255'));
    const { user } = renderDm(api);
    const panel = await tierPanel('Daily');
    await user.click(await within(panel).findByRole('button', { name: 'Download 1 (1.0KB)' }));
    expect(await within(panel).findByText('aws exited 255')).toBeDefined();
  });
});

describe('DataManagement — server-side sync status', () => {
  it('follows a background sync on every tier and reports how each one ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new DmApi();
    api.statuses.set('aws-main:daily', downloadingStatus(2, 5));
    api.statuses.set('aws-main:hourly', { status: 'syncing', phase: 'repartitioning', progress: 0, filesDone: 3, filesTotal: 10, bytesDone: 0, bytesTotal: 0, message: '' });
    api.statuses.set('aws-main:cost-optimization', downloadingStatus(0, 1));
    renderDm(api);

    const daily = await tierPanel('Daily');
    expect(await within(daily).findByText(/^Downloading 2\/5 files/)).toBeDefined();
    const hourly = await tierPanel('Hourly');
    expect(within(hourly).getByText('3 / 10 days')).toBeDefined();
    const costOpt = await tierPanel('Cost Optimization');
    expect(within(costOpt).getByText(/^Downloading 0\/1 files/)).toBeDefined();
    // Header Sync is held while anything runs.
    expect(screen.getByRole('button', { name: 'Sync' })).toHaveProperty('disabled', true);

    const readsBefore = api.inventoryReads;
    api.statuses.set('aws-main:daily', { status: 'completed', lastSync: new Date(), filesDownloaded: 5 });
    api.statuses.set('aws-main:hourly', { status: 'failed', error: new Error('No space left on device'), lastSync: null });
    api.statuses.set('aws-main:cost-optimization', IDLE);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(within(daily).getByText('Synced 5 files')).toBeDefined();
    expect(within(hourly).getByText('No space left on device')).toBeDefined();
    expect(within(costOpt).queryByText(/^Downloading/)).toBeNull();
    await waitFor(() => { expect(api.inventoryReads).toBeGreaterThan(readsBefore); });
    expect(screen.getByRole('button', { name: 'Sync' })).toHaveProperty('disabled', false);
  });

  it('ignores a terminal status left over from before the page was opened', async () => {
    const api = new DmApi();
    api.statuses.set('aws-main:daily', { status: 'completed', lastSync: new Date(), filesDownloaded: 9 });
    api.statuses.set('aws-main:hourly', { status: 'failed', error: new Error('old failure'), lastSync: null });
    renderDm(api);
    await tierPanel('Daily');
    await waitFor(() => { expect(screen.getAllByText('No data in the bucket yet.')).toHaveLength(3); });
    expect(screen.queryByText('Synced 9 files')).toBeNull();
    expect(screen.queryByText('old failure')).toBeNull();
  });

  it('shows the tiers of a sync already running while the inventory is still loading', async () => {
    const api = new DmApi();
    api.inventories.set('aws-main:daily', 'pending');
    api.statuses.set('aws-main:daily', downloadingStatus(1, 4));
    renderDm(api);
    const daily = await tierPanel('Daily');
    expect(within(daily).getByText(/^Downloading 1\/4 files/)).toBeDefined();
    expect(within(daily).getByText('Never')).toBeDefined();
    expect(screen.queryByText('Checking S3 for available data...')).toBeNull();
  });
  it('tracks a download it started through the live status, ignoring a terminal one until it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new DmApi();
    api.inventories.set('aws-main:daily', inventory([period('2099-12', 'missing')]));
    const pending = deferred<{ filesDownloaded: number; rowsProcessed: number }>();
    vi.spyOn(api, 'syncPeriods').mockReturnValue(pending.promise);
    const { user } = renderDm(api);
    const panel = await tierPanel('Daily');
    await user.click(await within(panel).findByRole('button', { name: 'Download 1 (1.0KB)' }));
    expect(screen.getByText(/^Downloading 0\/1 files/)).toBeDefined();
    const tick = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); };

    // A terminal status maps to nothing: the run is still in flight here.
    api.statuses.set('aws-main:daily', { status: 'completed', lastSync: new Date(), filesDownloaded: 4 });
    await tick();
    expect(screen.getByText(/^Downloading 0\/1 files/)).toBeDefined();

    api.statuses.set('aws-main:daily', downloadingStatus(3, 7));
    await tick();
    expect(await screen.findByText(/^Downloading 3\/7 files/)).toBeDefined();

    api.statuses.set('aws-main:daily', { status: 'syncing', phase: 'repartitioning', progress: 0, filesDone: 2, filesTotal: 9, bytesDone: 0, bytesTotal: 0, message: '' });
    await tick();
    expect(await screen.findByText('2 / 9 days')).toBeDefined();

    api.statuses.set('aws-main:daily', IDLE);
    await tick();
    await waitFor(() => { expect(screen.queryByText('2 / 9 days')).toBeNull(); });

    api.statuses.set('aws-main:daily', { status: 'completed', lastSync: new Date(), filesDownloaded: 4 });
    await act(async () => { pending.resolve({ filesDownloaded: 4, rowsProcessed: 40 }); await Promise.resolve(); });
    expect(await screen.findByText('Synced 4 files')).toBeDefined();
  });

  it('ignores a status poll that fails', async () => {
    const api = new DmApi();
    api.inventories.set('aws-main:daily', inventory([period('2099-12', 'missing')]));
    const poll = vi.fn<(syncId?: string) => Promise<SyncStatus>>().mockRejectedValue(new Error('ipc closed'));
    api.getSyncStatus = poll;
    renderDm(api);
    const panel = await tierPanel('Daily');
    expect(await within(panel).findByRole('button', { name: 'Download 1 (1.0KB)' })).toBeDefined();
    expect(poll).toHaveBeenCalledWith('aws-main:daily');
    expect(within(panel).queryByText(/^Downloading/)).toBeNull();
  });
});

describe('DataManagement — header actions', () => {
  it('Sync pulls each tier s missing and stale months, logging what every tier did', async () => {
    const api = new DmApi();
    api.inventories.set('aws-main:daily', inventory([period('2099-12', 'missing'), period('2099-11', 'stale'), period('2026-01', 'repartitioned')]));
    api.inventories.set('aws-main:hourly', { fail: new Error('SlowDown: please reduce your request rate') });
    api.inventories.set('aws-main:cost-optimization', inventory([period('2026-01', 'repartitioned')]));
    const log = vi.spyOn(api, 'appendSyncLog');
    const sync = vi.spyOn(api, 'syncPeriods').mockRejectedValue(new Error('quota exceeded'));
    const { user } = renderDm(api);

    const syncAll = await screen.findByRole('button', { name: 'Sync (2)' });
    const readsBefore = api.inventoryReads;
    await user.click(syncAll);
    // Tiers run in order, so the last one's line means the run is over.
    await waitFor(() => { expect(log).toHaveBeenCalledWith('info', 'aws-main/cost-optimization: up to date'); });
    expect(log).toHaveBeenCalledWith('info', 'Manual sync — checking S3 for new or updated data…');
    expect(sync).toHaveBeenCalledWith(
      [expect.objectContaining({ key: '2099-12/part-0.parquet' }), expect.objectContaining({ key: '2099-11/part-0.parquet' })],
      'aws-main:daily',
    );
    expect(log).toHaveBeenCalledWith('error', 'aws-main/daily: sync failed — quota exceeded');
    expect(log).toHaveBeenCalledWith('warn', 'aws-main/hourly: S3 check failed — SlowDown: please reduce your request rate');

    // It ends by re-reading every tier: three checks, then three refreshes.
    await waitFor(() => { expect(api.inventoryReads).toBeGreaterThanOrEqual(readsBefore + 6); });
    const again = await screen.findByRole('button', { name: 'Sync (2)' });
    await waitFor(() => { expect(again).toHaveProperty('disabled', false); });

    // The same failures, reported by a bridge that rejects with plain strings.
    api.inventories.set('aws-main:hourly', { fail: 'socket hang up' });
    sync.mockReturnValue(rejectWith('process killed'));
    await user.click(again);
    await waitFor(() => { expect(log).toHaveBeenCalledWith('warn', 'aws-main/hourly: S3 check failed — socket hang up'); });
    expect(log).toHaveBeenCalledWith('error', 'aws-main/daily: sync failed — process killed');
  });

  it('Prune reports what it removed, and why it failed', async () => {
    const api = new DmApi();
    const prune = vi.spyOn(api, 'pruneNow').mockResolvedValue({ deleted: [{ tier: 'daily', period: '2020-01' }] });
    const log = vi.spyOn(api, 'appendSyncLog');
    const { user } = renderDm(api);

    const confirmPrune = async (): Promise<void> => {
      await user.click(await screen.findByRole('button', { name: /^Prune/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Prune old data' });
      await user.click(within(dialog).getByRole('button', { name: 'Prune' }));
    };

    await confirmPrune();
    expect(await screen.findByText('Pruned 1 period(s) outside retention.')).toBeDefined();
    // Only the no-op is narrated here; the handler logs real removals itself.
    expect(log).not.toHaveBeenCalledWith('info', 'Prune — nothing outside the retention window');

    prune.mockRejectedValue(new Error('EBUSY: resource busy'));
    await confirmPrune();
    expect(await screen.findByText('Prune failed: EBUSY: resource busy')).toBeDefined();
    expect(log).toHaveBeenCalledWith('error', 'Prune failed — EBUSY: resource busy');

    prune.mockReturnValue(rejectWith('locked'));
    await confirmPrune();
    expect(await screen.findByText('Prune failed: locked')).toBeDefined();
  });

  it('Prune and Delete All can be backed out of without touching anything', async () => {
    const api = new DmApi();
    const prune = vi.spyOn(api, 'pruneNow');
    const remove = vi.spyOn(api, 'deleteLocalPeriod');
    const { user } = renderDm(api);

    await user.click(await screen.findByRole('button', { name: /^Prune/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Prune old data' })).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete All Data' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete all local data' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(prune).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('never counts data as expired under a zero-day retention', async () => {
    const api = new DmApi();
    api.config = configOf({ ...AWS_FULL, sync: { daily: { bucket: asBucketPath('acme-cur/daily'), retentionDays: 0 }, intervalMinutes: 60 } });
    api.inventories.set('aws-main:daily', inventory([], ['2020-01']));
    renderDm(api);
    await tierPanel('Daily');
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Prune' })).toBeDefined(); });
    expect(screen.queryByRole('button', { name: /^Prune \(/ })).toBeNull();
  });

  it('Delete All removes every downloaded month of every tier, skipping a tier it cannot read', async () => {
    const api = new DmApi();
    api.inventories.set('aws-main:daily', inventory([period('2026-01', 'repartitioned'), period('2099-12', 'missing')], ['2026-01']));
    api.inventories.set('aws-main:hourly', { fail: new Error('AccessDenied') });
    api.inventories.set('aws-main:cost-optimization', inventory([period('2026-02', 'repartitioned')], ['2026-02']));
    const remove = vi.spyOn(api, 'deleteLocalPeriod');
    const { user } = renderDm(api);

    await user.click(await screen.findByRole('button', { name: 'Delete All Data' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete all local data' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete All' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(remove.mock.calls).toEqual([['2026-01', 'daily', 'aws-main'], ['2026-02', 'cost-optimization', 'aws-main']]);
  });

  it('opens the data folder', async () => {
    const api = new DmApi();
    const open = vi.spyOn(api, 'openDataFolder');
    const { user } = renderDm(api);
    await user.click(await screen.findByRole('button', { name: 'Open Folder' }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('offers the config templates when no provider is configured', async () => {
    const api = new DmApi();
    api.config = configOf();
    const { user } = renderDm(api);
    await user.click(await screen.findByRole('button', { name: 'Generate config templates & open folder' }));
    expect(api.scaffoldedFor).toEqual(['aws']);
  });
});

describe('DataManagement — provider sections', () => {
  const GCP_KEYFILE: GcpProviderConfig = {
    name: asProviderName('gcp-key'),
    type: 'gcp',
    keyFile: '/secrets/reader.json',
    sync: { daily: { bucket: asBucketPath('gs://acme-key/focus/daily'), retentionDays: 365 }, intervalMinutes: 60 },
  };

  it('names how a GCP provider authenticates, and says it is reading Cloud Storage', async () => {
    const api = new DmApi();
    api.config = configOf(GCP_KEYFILE);
    api.inventories.set('gcp-key:daily', 'pending');
    renderDm(api);
    const section = await screen.findByRole('region', { name: 'Provider gcp-key' });
    expect(within(section).getByText('service account key')).toBeDefined();
    expect(await within(section).findByText('Checking Cloud Storage for available data...')).toBeDefined();
  });

  it('opens a GCP tier s Configure one folder above the daily export, beside where hourly lands', async () => {
    const api = new DmApi();
    api.config = configOf(GCP_KEYFILE);
    const { user } = renderDm(api);
    const section = await screen.findByRole('region', { name: 'Provider gcp-key' });
    await user.click(await within(section).findByTitle('Configure daily'));
    await waitFor(() => { expect(api.gcsBrowsed.length).toBeGreaterThan(0); });
    // A key-file provider names no reader to browse as.
    expect(api.gcsBrowsed[0]).toEqual({ projectId: '', bucket: 'acme-key', prefix: 'focus/' });
  });

  it('offers the gcloud CLI sign-in, not the ADC one, for a stale gcloud account', async () => {
    const api = new DmApi();
    api.config = configOf(GCP_KEYFILE);
    api.inventories.set('gcp-key:daily', { fail: new Error('gcloud has no active account. Run: gcloud auth login') });
    renderDm(api);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: /Sign in the gcloud CLI/ })).toBeDefined();
    // Re-running the ADC sign-in cannot fix gcloud's own account.
    expect(within(alert).queryByRole('button', { name: /Open Google Sign-in/ })).toBeNull();
  });

  it('opens a GCP tier s Configure at the bucket root when the export sits there, as the provider s reader', async () => {
    const reader = 'costgoblin-reader@acme.iam.gserviceaccount.com';
    const api = new DmApi();
    api.config = configOf({
      name: asProviderName('gcp-root'),
      type: 'gcp',
      impersonateServiceAccount: reader,
      sync: { daily: { bucket: asBucketPath('gs://acme-root/daily'), retentionDays: 365 }, intervalMinutes: 60 },
    });
    const { user } = renderDm(api);
    const section = await screen.findByRole('region', { name: 'Provider gcp-root' });
    await user.click(await within(section).findByTitle('Configure daily'));
    await waitFor(() => { expect(api.gcsBrowsed.length).toBeGreaterThan(0); });
    expect(api.gcsBrowsed[0]).toEqual({ projectId: '', bucket: 'acme-root', prefix: '', impersonateServiceAccount: reader });
  });

  it('Retry on an AWS failure re-reads every tier without asking Google who is signed in', async () => {
    const api = new DmApi();
    api.inventories.set('aws-main:daily', { fail: new Error('AccessDenied: s3:ListBucket') });
    const { user } = renderDm(api);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('AccessDenied: s3:ListBucket');
    api.inventories.delete('aws-main:daily');
    const readsBefore = api.inventoryReads;
    await user.click(within(alert).getByRole('button', { name: /Retry/ }));
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
    // Daily, hourly and cost optimization are all read again.
    expect(api.inventoryReads - readsBefore).toBeGreaterThanOrEqual(3);
    expect(api.gcpIdentitiesRequestedFor).toEqual([]);
  });

  it('heals an expired AWS sign-in on its own once the inventory reads again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = new DmApi();
    api.inventories.set('aws-main:daily', { fail: new Error('The SSO session for profile default has expired. Run `aws sso login --profile default` and retry.') });
    renderDm(api);
    expect(await screen.findByText(/SSO session for profile default has expired/)).toBeDefined();
    expect(screen.getByText('Open SSO Login')).toBeDefined();

    api.inventories.delete('aws-main:daily');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => { expect(screen.queryByText(/has expired/)).toBeNull(); });
    expect(api.gcpIdentitiesRequestedFor).toEqual([]);
  });

  it('Remove can be cancelled, and a failed removal keeps the provider', async () => {
    const api = new DmApi();
    api.config = configOf(AWS_FULL, { ...AWS_FULL, name: asProviderName('aws-b'), credentialsProfile: 'prod' });
    const remove = vi.spyOn(api, 'removeProvider').mockRejectedValue(new Error('config locked'));
    const { user } = renderDm(api);
    const second = await screen.findByRole('region', { name: 'Provider aws-b' });

    await user.click(within(second).getByRole('button', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Remove provider "aws-b"' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(remove).not.toHaveBeenCalled();

    await user.click(within(second).getByRole('button', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Remove provider "aws-b"' })).getByRole('button', { name: 'Remove' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(remove).toHaveBeenCalledWith('aws-b');
    expect(screen.getByRole('region', { name: 'Provider aws-b' })).toBeDefined();
  });

  it('re-reads the configuration once the Add Provider wizard finishes', async () => {
    const api = new DmApi();
    const { user } = renderDm(api);
    await user.click(await screen.findByRole('button', { name: 'Add Provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add provider' });
    await user.click(within(dialog).getByLabelText('Set up from AWS'));
    const readsBefore = api.configReads;
    await user.click(await within(dialog).findByRole('button', { name: /^Skip/ }));
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Add provider' })).toBeNull(); });
    await waitFor(() => { expect(api.configReads).toBeGreaterThan(readsBefore); });
  });

  it('re-reads the configuration once a tier s Configure wizard is completed', async () => {
    const api = new DmApi();
    const write = vi.spyOn(api, 'writeConfig');
    const { user } = renderDm(api);
    const daily = await tierPanel('Daily');
    await user.click(within(daily).getByTitle('Configure daily'));
    const dialog = await screen.findByRole('dialog', { name: 'Configure daily data source for aws-main' });
    await user.click(await within(dialog).findByText('my-cur-bucket'));
    await user.click(await within(dialog).findByText('Use this location'));
    const readsBefore = api.configReads;
    await user.click(await within(dialog).findByText('Complete Setup'));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ providerName: 'aws-main', profile: 'default' }));
    await waitFor(() => { expect(api.configReads).toBeGreaterThan(readsBefore); });
  });
});

describe('DataManagement — Change AWS Profile', () => {
  async function openSwap(api: DmApi) {
    const rendered = renderDm(api);
    await rendered.user.click(await screen.findByRole('button', { name: 'Change AWS Profile' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change AWS Profile' });
    return { ...rendered, dialog };
  }

  it('saves only a different profile, for this provider, then re-reads the configuration', async () => {
    const api = new DmApi();
    const update = vi.spyOn(api, 'updateAwsProfile');
    const { user, dialog } = await openSwap(api);
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    await user.click(await within(dialog).findByRole('button', { name: /^prod/ }));
    expect(save).toHaveProperty('disabled', false);

    const readsBefore = api.configReads;
    await user.click(save);
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(update).toHaveBeenCalledWith('prod', 'aws-main');
    await waitFor(() => { expect(api.configReads).toBeGreaterThan(readsBefore); });
  });

  it('shows Saving… while the update runs, and the error if it fails', async () => {
    const api = new DmApi();
    const pending = deferred<undefined>();
    vi.spyOn(api, 'updateAwsProfile').mockReturnValue(pending.promise);
    const { user, dialog } = await openSwap(api);
    await user.click(await within(dialog).findByRole('button', { name: /^staging/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);

    await act(async () => { pending.reject(new Error('costgoblin.yaml is read-only')); await Promise.resolve(); });
    expect(await within(dialog).findByText('costgoblin.yaml is read-only')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  });

  it('reports a failure that is not an Error', async () => {
    const api = new DmApi();
    vi.spyOn(api, 'updateAwsProfile').mockReturnValue(rejectWith('EACCES'));
    const { user, dialog } = await openSwap(api);
    await user.click(await within(dialog).findByRole('button', { name: /^prod/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('EACCES')).toBeDefined();
  });

  it('says when the profiles are loading, unreadable, or absent', async () => {
    const loading = new DmApi();
    vi.spyOn(loading, 'listAwsProfiles').mockReturnValue(new Promise<string[]>(() => undefined));
    const first = await openSwap(loading);
    expect(within(first.dialog).getByText('Loading profiles…')).toBeDefined();
    cleanup();

    const broken = new DmApi();
    vi.spyOn(broken, 'listAwsProfiles').mockRejectedValue(new Error('~/.aws/config: parse error on line 3'));
    const second = await openSwap(broken);
    expect(await within(second.dialog).findByText('~/.aws/config: parse error on line 3')).toBeDefined();
    cleanup();

    const empty = new DmApi();
    vi.spyOn(empty, 'listAwsProfiles').mockResolvedValue([]);
    const third = await openSwap(empty);
    expect(await within(third.dialog).findByText('No AWS profiles found in ~/.aws.')).toBeDefined();
  });
});
