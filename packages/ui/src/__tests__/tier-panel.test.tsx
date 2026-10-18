import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { DataInventoryResult } from '@costgoblin/core/browser';
import { TierPanel, formatBytes, formatPeriod } from '../views/data-management-tier.js';
import type { SyncState } from '../views/data-management-tier.js';

type Period = DataInventoryResult['periods'][number];

function period(name: string, localStatus: Period['localStatus'], size: number): Period {
  return { period: name, localStatus, totalSize: size, files: [{ key: `daily/${name}/part-0.parquet`, contentHash: `h-${name}`, size }] };
}

type Props = ComponentProps<typeof TierPanel>;

function renderTier(overrides: Partial<Props> = {}) {
  const props: Props = {
    title: 'Daily',
    configured: true,
    bucket: 's3://acme-cur/daily/',
    retentionDays: 90,
    localPeriods: [],
    diskBytes: 0,
    oldestPeriod: null,
    newestPeriod: null,
    lastSync: null,
    periods: [],
    selected: new Set<string>(),
    onToggle: vi.fn(),
    onSelectAll: vi.fn(),
    onDeselectAll: vi.fn(),
    onDownload: vi.fn(),
    onDeletePeriod: vi.fn(),
    syncState: { status: 'idle' },
    ...overrides,
  };
  const user = userEvent.setup();
  return { user, props, ...render(<TierPanel {...props} />) };
}

afterEach(cleanup);

describe('formatBytes / formatPeriod', () => {
  it.each([
    { bytes: 512, text: '512B' },
    { bytes: 2048, text: '2.0KB' },
    { bytes: 5 * 1024 * 1024, text: '5MB' },
    { bytes: 3.5 * 1024 * 1024 * 1024, text: '3.5GB' },
  ])('formats $bytes bytes as $text', ({ bytes, text }) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it('names the month, and keeps an unknown month as it was given', () => {
    expect(formatPeriod('2026-03')).toBe('Mar 2026');
    expect(formatPeriod('2026-13')).toBe('13 2026');
    expect(formatPeriod('')).toBe(' ');
  });
});

describe('TierPanel — not configured', () => {
  it('points at costgoblin.yaml when the host offers no Configure', () => {
    renderTier({ title: 'Hourly', configured: false });
    expect(screen.getByText('Not configured')).toBeDefined();
    expect(screen.getByText('hourly')).toBeDefined();
    expect(screen.getByText('costgoblin.yaml')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Configure when the host can open the wizard', async () => {
    const onConfigure = vi.fn();
    const { user } = renderTier({ title: 'Cost Optimization', configured: false, onConfigure });
    await user.click(screen.getByRole('button', { name: 'Configure cost optimization data source' }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });
});

describe('TierPanel — configured', () => {
  it('shows placeholders for a tier with no bucket, retention, sync or local data', () => {
    renderTier({ bucket: null, retentionDays: null });
    expect(screen.getAllByText('—')).toHaveLength(3);
    expect(screen.getByText('Never')).toBeDefined();
    expect(screen.getByText('0B')).toBeDefined();
    expect(screen.getByText('No data in the bucket yet.')).toBeDefined();
    // No gear without a Configure handler.
    expect(screen.queryByTitle('Configure daily')).toBeNull();
  });

  it('shows the bucket, retention, last sync and local range', async () => {
    const onConfigure = vi.fn();
    const lastSync = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const { user } = renderTier({
      onConfigure,
      lastSync,
      localPeriods: ['2026-08', '2026-09'],
      diskBytes: 20 * 1024 * 1024,
      oldestPeriod: '2026-08',
      newestPeriod: '2026-09',
    });
    expect(screen.getByText('s3://acme-cur/daily/')).toBeDefined();
    expect(screen.getByText('90 days')).toBeDefined();
    const sync = screen.getByText('3h ago');
    expect(sync.getAttribute('title')).toBe(new Date(lastSync).toLocaleString());
    expect(screen.getByText('20MB')).toBeDefined();
    expect(screen.getByText('2026-08')).toBeDefined();
    expect(screen.getByText('to 2026-09')).toBeDefined();

    await user.click(screen.getByTitle('Configure daily'));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });

  it.each<{ name: string; state: SyncState; width: string; label: string }>([
    {
      name: 'bytes, once the first ones land',
      state: { status: 'downloading', filesDone: 0, filesTotal: 4, bytesDone: 256, bytesTotal: 1024, message: 'Completed 256 Bytes/1.0 KiB' },
      width: '25%',
      label: 'Downloading 0/4 files',
    },
    {
      name: 'the file count before any bytes',
      state: { status: 'downloading', filesDone: 1, filesTotal: 2, bytesDone: 0, bytesTotal: 0, message: '' },
      width: '50%',
      label: 'Downloading 1/2 files',
    },
    {
      name: 'nothing, with neither known yet',
      state: { status: 'downloading', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, message: '' },
      width: '0%',
      label: 'Downloading 0/0 files',
    },
  ])('draws the download bar from $name', ({ state, width, label }) => {
    const { container } = renderTier({ syncState: state });
    expect(screen.getByText(label)).toBeDefined();
    const bar = container.querySelector('.h-1 > div');
    if (!(bar instanceof HTMLElement)) throw new Error('progress bar missing');
    expect(bar.style.width).toBe(width);
    const message = state.status === 'downloading' ? state.message : '';
    if (message.length > 0) expect(screen.getByText(message)).toBeDefined();
    else expect(container.querySelector('p.font-mono')).toBeNull();
  });

  it('cancels a download from its ✕, even without a cancel handler', async () => {
    const onCancelSync = vi.fn();
    const downloading: SyncState = { status: 'downloading', filesDone: 0, filesTotal: 1, bytesDone: 0, bytesTotal: 0, message: '' };
    const { user } = renderTier({ syncState: downloading, onCancelSync });
    await user.click(screen.getByTitle('Cancel download'));
    expect(onCancelSync).toHaveBeenCalledTimes(1);
    cleanup();

    const bare = renderTier({ syncState: downloading });
    await bare.user.click(screen.getByTitle('Cancel download'));
    expect(screen.getByText('Downloading 0/1 files')).toBeDefined();
  });

  it('shows repartitioning progress, and an empty bar before the day count is known', () => {
    const { container } = renderTier({ syncState: { status: 'repartitioning', datesDone: 3, datesTotal: 4 } });
    expect(screen.getByText('Processing — repartitioning into daily partitions')).toBeDefined();
    expect(screen.getByText('3 / 4 days')).toBeDefined();
    const bar = container.querySelector('.h-1\\.5 > div');
    if (!(bar instanceof HTMLElement)) throw new Error('progress bar missing');
    expect(bar.style.width).toBe('75%');
    cleanup();

    const unknown = renderTier({ syncState: { status: 'repartitioning', datesDone: 0, datesTotal: 0 } });
    const empty = unknown.container.querySelector('.h-1\\.5 > div');
    if (!(empty instanceof HTMLElement)) throw new Error('progress bar missing');
    expect(empty.style.width).toBe('0%');
  });

  it('reports a finished sync and a failed one', () => {
    renderTier({ syncState: { status: 'done', filesDownloaded: 7 } });
    expect(screen.getByText('Synced 7 files')).toBeDefined();
    cleanup();
    renderTier({ syncState: { status: 'error', message: 'aws s3 sync exited with code 1' } });
    expect(screen.getByText('aws s3 sync exited with code 1')).toBeDefined();
  });

  it('lists available months with a stale badge, and passes picks and bulk picks up', async () => {
    const periods = [period('2026-09', 'missing', 2048), period('2026-08', 'stale', 1024)];
    const { user, props } = renderTier({ periods });
    const available = screen.getByText('Available').closest('div.rounded-lg');
    if (!(available instanceof HTMLElement)) throw new Error('available list missing');
    expect(within(available).getByText('Sep 2026')).toBeDefined();
    const stale = within(available).getByText('Aug 2026').closest('label');
    if (stale === null) throw new Error('stale row missing');
    expect(within(stale).getByText('stale')).toBeDefined();

    await user.click(within(available).getAllByRole('checkbox')[0] ?? document.body);
    expect(props.onToggle).toHaveBeenCalledWith('2026-09');
    await user.click(within(available).getByRole('button', { name: 'All' }));
    expect(props.onSelectAll).toHaveBeenCalledTimes(1);
    await user.click(within(available).getByRole('button', { name: 'None' }));
    expect(props.onDeselectAll).toHaveBeenCalledTimes(1);
    // Nothing picked: no download button.
    expect(within(available).queryByRole('button', { name: /^Download/ })).toBeNull();
  });

  it('downloads the picked months, and locks the button while a sync runs', async () => {
    const periods = [period('2026-09', 'missing', 2048), period('2026-08', 'missing', 1024)];
    const selected = new Set(['2026-09', '2026-08']);
    const { user, props } = renderTier({ periods, selected });
    const download = screen.getByRole('button', { name: 'Download 2 (3.0KB)' });
    await user.click(download);
    expect(props.onDownload).toHaveBeenCalledTimes(1);
    cleanup();

    renderTier({ periods, selected, syncState: { status: 'repartitioning', datesDone: 0, datesTotal: 1 } });
    expect(screen.getByRole('button', { name: 'Download 2 (3.0KB)' })).toHaveProperty('disabled', true);
  });

  it('deletes a downloaded month only after confirming', async () => {
    const periods = [period('2026-07', 'repartitioned', 5 * 1024 * 1024)];
    const { user, props } = renderTier({ title: 'Hourly', periods });
    expect(screen.getByText('Downloaded')).toBeDefined();
    expect(screen.getByText('5MB')).toBeDefined();

    await user.click(screen.getByRole('button', { name: '✕' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete local data' });
    expect(within(dialog).getByText('Remove local hourly data for Jul 2026? The data can be re-downloaded from S3.')).toBeDefined();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(props.onDeletePeriod).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '✕' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete local data' })).getByRole('button', { name: 'Delete' }));
    expect(props.onDeletePeriod).toHaveBeenCalledWith('2026-07');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
