import { asBucketPath, asProviderName } from '@costgoblin/core/browser';
import type { DataSharingStatus, SharedSourcePreview } from '@costgoblin/core/browser';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BundleSummaryCard, ImportConfigDialog, ShareConfigDialog } from '../components/config-sharing.js';
import { SharingActiveBanner } from '../components/sharing-active-banner.js';
import { autoStopLabel, autoStopMinutes } from '../components/sharing-auto-stop.js';
import { MOCK_BUNDLE_SUMMARY, MOCK_SHARED_SOURCE, MOCK_SHARED_SOURCE_PREVIEW, MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';

/** Config whose sync profile differs from the alphabetical-first AWS
 *  profile, to pin down "configured profile wins as the default". */
function configWithProfile(profile: string): MockCostApi['getConfig'] {
  return () => Promise.resolve({
    providers: [{
      name: asProviderName('aws-main'),
      type: 'aws',
      credentialsProfile: profile,
      sync: { daily: { bucket: asBucketPath('costgoblin-cur-bucket/daily'), retentionDays: 90 }, intervalMinutes: 60 },
    }],
    defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
  });
}

function renderWithApi(api: MockCostApi, ui: React.JSX.Element) {
  return render(<CostApiProvider value={api}>{ui}</CostApiProvider>);
}

describe('BundleSummaryCard', () => {
  it('shows providers, counts and fingerprint', () => {
    render(<BundleSummaryCard summary={MOCK_BUNDLE_SUMMARY} />);
    expect(screen.getByText('s3://my-cur-bucket/daily/')).toBeDefined();
    expect(screen.getByText('7 built-in + 3 tags')).toBeDefined();
    expect(screen.getByText('12 nodes')).toBeDefined();
    expect(screen.getByText('6 exclusion rules')).toBeDefined();
    expect(screen.getByText('2 views')).toBeDefined();
    expect(screen.getByText(MOCK_BUNDLE_SUMMARY.fingerprint.slice(0, 16))).toBeDefined();
    expect(screen.queryByText(/fingerprint mismatch/i)).toBeNull();
  });

  it('warns when the fingerprint does not match', () => {
    render(<BundleSummaryCard summary={{ ...MOCK_BUNDLE_SUMMARY, fingerprintValid: false }} />);
    expect(screen.getByText(/fingerprint mismatch/i)).toBeDefined();
  });
});

describe('ShareConfigDialog', () => {
  it('is a modal dialog named by its title', () => {
    renderWithApi(new MockCostApi(), <ShareConfigDialog onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Share configuration' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('moves focus into the dialog on open', () => {
    renderWithApi(new MockCostApi(), <ShareConfigDialog onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Share configuration' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes from the named ✕, Escape and the aria-hidden backdrop', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithApi(new MockCostApi(), <ShareConfigDialog onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Share configuration' });

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await user.keyboard('{Escape}');
    const backdrop = dialog.querySelector(':scope > [aria-hidden="true"]');
    if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not found');
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('exports to a file and shows the saved path', async () => {
    const api = new MockCostApi();
    const exportSpy = vi.spyOn(api, 'exportConfigBundle');
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    await user.click(screen.getByText('Export…'));
    await waitFor(() => {
      expect(screen.getByText(/costgoblin-config-2026-06-11\.yaml/)).toBeDefined();
    });
    expect(exportSpy).toHaveBeenCalledOnce();
  });

  it('prefills the publish destination from the daily sync bucket root', async () => {
    renderWithApi(new MockCostApi(), <ShareConfigDialog onClose={() => undefined} />);
    const input = await screen.findByLabelText('Destination');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    expect(screen.queryByText('Reset to default')).toBeNull();
  });

  it('publishes to the shown destination and reports the location', async () => {
    const api = new MockCostApi();
    const publishSpy = vi.spyOn(api, 'publishConfigBundle');
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    const input = await screen.findByLabelText('Destination');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.click(screen.getByText('Publish'));
    await waitFor(() => {
      expect(screen.getByText(/Published to s3:\/\/costgoblin-cur-bucket\/costgoblin\/org-config\.yaml/)).toBeDefined();
    });
    expect(publishSpy).toHaveBeenCalledWith({ location: 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml', profile: 'default' });
  });

  it('publishes with an explicitly chosen elevated profile', async () => {
    const api = new MockCostApi();
    const publishSpy = vi.spyOn(api, 'publishConfigBundle');
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    const input = await screen.findByLabelText('Destination');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.click(screen.getByRole('button', { name: 'staging' }));
    await user.click(screen.getByText('Publish'));
    await waitFor(() => {
      expect(publishSpy).toHaveBeenCalledWith({ location: 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml', profile: 'staging' });
    });
  });

  it('publishes to an edited destination and warns it is not auto-discovered', async () => {
    const api = new MockCostApi();
    const publishSpy = vi.spyOn(api, 'publishConfigBundle');
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    const input = await screen.findByLabelText('Destination');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.clear(input);
    await user.type(input, 's3://config-bucket/shared/finops.yaml');
    expect(screen.getByText(/share this location with teammates yourself/i)).toBeDefined();

    await user.click(screen.getByText('Publish'));
    await waitFor(() => {
      expect(screen.getByText(/Published to s3:\/\/config-bucket\/shared\/finops\.yaml/)).toBeDefined();
    });
    expect(publishSpy).toHaveBeenCalledWith({ location: 's3://config-bucket/shared/finops.yaml', profile: 'default' });
  });

  it('resets an edited destination back to the default', async () => {
    const api = new MockCostApi();
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    const input = await screen.findByLabelText('Destination');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.clear(input);
    await user.type(input, 's3://elsewhere/org.yaml');
    await user.click(screen.getByText('Reset to default'));
    expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
  });

  it('disables publish while the destination is invalid', async () => {
    const api = new MockCostApi();
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    const input = await screen.findByLabelText('Destination');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.clear(input);
    await user.type(input, 's3://bucket-only');
    expect(screen.getByText(/Enter a full object location/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows when sharing will auto-stop once started', async () => {
    const api = new MockCostApi();
    const autoStopsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const enabled = await api.enableDataSharing();
    if (enabled.status !== 'ok') throw new Error('mock enable failed');
    api.enableDataSharing = () => Promise.resolve({ status: 'ok', sharing: { ...enabled.sharing, autoStopsAt } });
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    expect(screen.queryByText(/Auto-stops/)).toBeNull();
    await user.click(await screen.findByText('Start sharing'));
    expect(await screen.findByText('Auto-stops in 30 min if idle')).toBeDefined();
  });

  it('shows no auto-stop hint while sharing without a deadline', async () => {
    const api = new MockCostApi();
    const enabled = await api.enableDataSharing();
    if (enabled.status !== 'ok') throw new Error('mock enable failed');
    api.enableDataSharing = () => Promise.resolve({ status: 'ok', sharing: { ...enabled.sharing, autoStopsAt: null } });
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    await user.click(await screen.findByText('Start sharing'));
    await screen.findByText('Sharing key');
    expect(screen.queryByText(/Auto-stops/)).toBeNull();
  });

  it('surfaces publish errors', async () => {
    const api = new MockCostApi();
    api.publishConfigBundle = () => Promise.resolve({ status: 'error', message: 'AccessDenied: no s3:PutObject' });
    const user = userEvent.setup();
    renderWithApi(api, <ShareConfigDialog onClose={() => undefined} />);

    const input = await screen.findByLabelText('Destination');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.click(screen.getByText('Publish'));
    await waitFor(() => {
      expect(screen.getByText(/AccessDenied/)).toBeDefined();
    });
  });
});

describe('ImportConfigDialog', () => {
  // The dialog can open above a window drag region (e.g. the standalone setup
  // wizard's backdrop, issue #317); without an explicit no-drag opt-out, clicks
  // on it would drag the window instead of reaching the modal.
  it('opts the modal out of window drag regions', () => {
    const api = new MockCostApi();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'Import configuration' });
    expect(dialog.className).toContain('[-webkit-app-region:no-drag]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('previews a bundle, applies it with the chosen profile, then reports done', async () => {
    const api = new MockCostApi();
    const applySpy = vi.spyOn(api, 'applyConfigBundle');
    const onApplied = vi.fn();
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={onApplied} />);

    await user.click(screen.getByText('Choose bundle file…'));
    await waitFor(() => {
      expect(screen.getByText('s3://my-cur-bucket/daily/')).toBeDefined();
    });

    await user.click(screen.getByRole('button', { name: 'prod' }));
    await user.click(screen.getByText('Apply configuration'));
    await waitFor(() => {
      expect(screen.getByText('Configuration applied.')).toBeDefined();
    });
    expect(applySpy).toHaveBeenCalledWith({ content: 'kind: costgoblin-config-bundle', credentialsProfile: 'prod' });

    await user.click(screen.getByText('Done'));
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('stays on the picker and shows the message when the file is invalid', async () => {
    const api = new MockCostApi();
    api.previewConfigBundleFile = () => Promise.resolve({ status: 'error', message: 'Not a CostGoblin configuration bundle' });
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    await user.click(screen.getByText('Choose bundle file…'));
    await waitFor(() => {
      expect(screen.getByText(/not a costgoblin configuration bundle/i)).toBeDefined();
    });
    expect(screen.getByText('Choose bundle file…')).toBeDefined();
  });

  it('returns to the picker silently when the file dialog is canceled', async () => {
    const api = new MockCostApi();
    api.previewConfigBundleFile = () => Promise.resolve({ status: 'canceled' });
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    await user.click(screen.getByText('Choose bundle file…'));
    await waitFor(() => {
      expect(screen.getByText('Choose bundle file…')).toBeDefined();
    });
    expect(screen.queryByText('Apply configuration')).toBeNull();
  });

  it('fetches a bundle from S3 (prefilled with the team beacon) and applies it', async () => {
    const api = new MockCostApi();
    const fetchSpy = vi.spyOn(api, 'fetchConfigBundleFromS3');
    const applySpy = vi.spyOn(api, 'applyConfigBundle');
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    const input = await screen.findByLabelText('S3 location');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.click(screen.getByText('Fetch from S3'));
    await waitFor(() => {
      expect(screen.getByText('s3://my-cur-bucket/daily/')).toBeDefined();
    });
    expect(fetchSpy).toHaveBeenCalledWith({ profile: 'default', location: 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml' });

    await user.click(screen.getByText('Apply configuration'));
    await waitFor(() => {
      expect(screen.getByText('Configuration applied.')).toBeDefined();
    });
    expect(applySpy).toHaveBeenCalledWith({ content: 'kind: costgoblin-config-bundle', credentialsProfile: 'default' });
  });

  it('fetches from an edited S3 location with the chosen profile', async () => {
    const api = new MockCostApi();
    const fetchSpy = vi.spyOn(api, 'fetchConfigBundleFromS3');
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    const input = await screen.findByLabelText('S3 location');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.click(screen.getByRole('button', { name: 'staging' }));
    await user.clear(input);
    await user.type(input, 's3://client-bucket/costgoblin/org-config.yaml');
    await user.click(screen.getByText('Fetch from S3'));
    await waitFor(() => {
      expect(screen.getByText('Apply configuration')).toBeDefined();
    });
    expect(fetchSpy).toHaveBeenCalledWith({ profile: 'staging', location: 's3://client-bucket/costgoblin/org-config.yaml' });
  });

  it('defaults the fetch profile to the configured sync profile, not the first profile', async () => {
    const api = new MockCostApi();
    api.getConfig = configWithProfile('staging');
    const fetchSpy = vi.spyOn(api, 'fetchConfigBundleFromS3');
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    const input = await screen.findByLabelText('S3 location');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.click(screen.getByText('Fetch from S3'));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith({ profile: 'staging', location: 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml' });
    });
  });

  it('shows S3 fetch errors and stays on the picker', async () => {
    const api = new MockCostApi();
    api.fetchConfigBundleFromS3 = () => Promise.resolve({ status: 'error', message: 'No bundle found at s3://bucket/costgoblin/org-config.yaml (missing object or access denied)' });
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    const input = await screen.findByLabelText('S3 location');
    await waitFor(() => {
      expect(input).toHaveProperty('value', 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml');
    });
    await user.click(screen.getByText('Fetch from S3'));
    await waitFor(() => {
      expect(screen.getByText(/No bundle found at/)).toBeDefined();
    });
    expect(screen.getByText('Choose bundle file…')).toBeDefined();
  });

  it('keeps the preview visible when apply fails', async () => {
    const api = new MockCostApi();
    api.applyConfigBundle = () => Promise.resolve({ status: 'error', message: 'disk full' });
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    await user.click(screen.getByText('Choose bundle file…'));
    await waitFor(() => {
      expect(screen.getByText('Apply configuration')).toBeDefined();
    });
    await user.click(screen.getByText('Apply configuration'));
    await waitFor(() => {
      expect(screen.getByText('disk full')).toBeDefined();
    });
    expect(screen.getByText('Apply configuration')).toBeDefined();
  });
});

describe('autoStopMinutes / autoStopLabel', () => {
  const NOW = Date.parse('2026-09-29T10:00:00.000Z');
  const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

  it('is null when there is no deadline (or an unreadable one)', () => {
    expect(autoStopMinutes(null, NOW)).toBeNull();
    expect(autoStopMinutes('not a date', NOW)).toBeNull();
    expect(autoStopLabel(null, NOW)).toBeNull();
  });

  it('rounds the remaining time up to whole minutes', () => {
    expect(autoStopMinutes(at(30 * 60_000), NOW)).toBe(30);
    expect(autoStopMinutes(at(29 * 60_000 + 1), NOW)).toBe(30);
    expect(autoStopMinutes(at(90_000), NOW)).toBe(2);
  });

  it('never shows less than 1 minute', () => {
    expect(autoStopMinutes(at(5_000), NOW)).toBe(1);
    expect(autoStopMinutes(at(0), NOW)).toBe(1);
    expect(autoStopMinutes(at(-60_000), NOW)).toBe(1);
  });

  it('formats the hint', () => {
    expect(autoStopLabel(at(30 * 60_000), NOW)).toBe('Auto-stops in 30 min if idle');
  });
});

describe('SharingActiveBanner', () => {
  const activeStatus: DataSharingStatus = {
    enabled: true,
    sharingKey: 'CGSHARE1-active',
    label: 'My Mac · CostGoblin',
    port: 53178,
    hosts: ['192.168.1.5'],
    fingerprint: 'ABCD-1234',
    lastServedAt: '2026-06-21T09:00:00.000Z',
    filesServed: 12,
    lastPeer: '192.168.1.9',
    bytesServed: 5_000_000,
    connectedClients: 2,
    bytesPerSecond: 1_500_000,
    autoStopsAt: null,
  };

  it('shows connected peers, files + bytes served, and throughput', () => {
    render(<SharingActiveBanner status={activeStatus} onStop={() => undefined} />);
    expect(screen.getByText('2 connected')).toBeDefined();
    expect(screen.getByText('12 files · 4.8 MB')).toBeDefined();
    expect(screen.getByText('1.4 MB/s')).toBeDefined();
  });

  it('shows when sharing will auto-stop if idle', () => {
    const autoStopsAt = new Date(Date.now() + 30 * 60_000).toISOString();
    render(<SharingActiveBanner status={{ ...activeStatus, autoStopsAt }} onStop={() => undefined} />);
    expect(screen.getByText('Auto-stops in 30 min if idle')).toBeDefined();
  });

  it('shows no auto-stop hint when there is no deadline', () => {
    render(<SharingActiveBanner status={activeStatus} onStop={() => undefined} />);
    expect(screen.queryByText(/Auto-stops/)).toBeNull();
  });

  it('hides throughput when idle and fires onStop', async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<SharingActiveBanner status={{ ...activeStatus, connectedClients: 0, bytesPerSecond: 0 }} onStop={onStop} />);
    expect(screen.queryByText(/\/s$/)).toBeNull();
    await user.click(screen.getByText('Stop sharing'));
    expect(onStop).toHaveBeenCalledOnce();
  });
});

describe('ImportConfigDialog — pull from a teammate', () => {
  it('reconnects to a saved teammate, lets you deselect a month, and refreshes with that selection', async () => {
    const api = new MockCostApi();
    api.getSharedSource = () => Promise.resolve(MOCK_SHARED_SOURCE);
    const refreshSpy = vi.spyOn(api, 'refreshSharedSource');
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    await user.click(await screen.findByText('Reconnect'));
    // Preview resolves to the month picker.
    await waitFor(() => { expect(screen.getByText('2026-04')).toBeDefined(); });
    // Drop one month from the (all-selected-by-default) set, then pull.
    await user.click(screen.getByText('2026-04'));
    await user.click(screen.getByText('Pull'));

    await waitFor(() => { expect(refreshSpy).toHaveBeenCalled(); });
    const selection = refreshSpy.mock.calls[0]?.[0];
    expect(selection?.periods).not.toContain('2026-04');
    expect(selection?.periods).toContain('2026-05');
    expect(selection?.sources).toContain('daily');
  });

  it('previews a pasted key and pulls the chosen sources', async () => {
    const api = new MockCostApi();
    const addSpy = vi.spyOn(api, 'addSharedSource');
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);

    await user.type(screen.getByLabelText('Sharing key from a teammate'), 'CGSHARE1-teammate');
    await user.click(screen.getByText('Continue'));
    // Preview resolves to the tier picker (asserted via the tier we toggle next).
    await waitFor(() => { expect(screen.getByText('Cost optimization')).toBeDefined(); });
    // Drop the cost-optimization tier, keep the rest, and pull.
    await user.click(screen.getByText('Cost optimization'));
    await user.click(screen.getByText('Pull'));

    await waitFor(() => { expect(addSpy).toHaveBeenCalled(); });
    const [key, selection] = addSpy.mock.calls[0] ?? [];
    expect(key).toBe('CGSHARE1-teammate');
    expect(selection?.sources).toContain('daily');
    expect(selection?.sources).not.toContain('cost-optimization');
  });

  async function openPreview(api: MockCostApi, preview: SharedSourcePreview): Promise<ReturnType<typeof userEvent.setup>> {
    api.previewSharedSource = () => Promise.resolve({ status: 'ok', preview });
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={() => undefined} onApplied={() => undefined} />);
    await user.type(screen.getByLabelText('Sharing key from a teammate'), 'CGSHARE1-teammate');
    await user.click(screen.getByText('Continue'));
    await screen.findByText('Pull');
    return user;
  }

  it('discloses that Configuration also replaces account & region names', async () => {
    await openPreview(new MockCostApi(), { ...MOCK_SHARED_SOURCE_PREVIEW, enrichment: { accounts: 12, regions: 30 } });
    expect(screen.getByLabelText(/Configuration/)).toHaveProperty('checked', true);
    // The existing config hint stays, and the names overwrite is added to it.
    expect(screen.getByText(/Dimensions, dashboards, cost scope & org tree/)).toBeDefined();
    expect(screen.getByText('Also replaces your account & region names (12 accounts, 30 regions)')).toBeDefined();
  });

  it('offers the Configuration checkbox for enrichment alone, even without a config bundle', async () => {
    await openPreview(new MockCostApi(), { ...MOCK_SHARED_SOURCE_PREVIEW, hasConfig: false, enrichment: { accounts: 1, regions: 0 } });
    expect(screen.getByLabelText(/Configuration/)).toHaveProperty('checked', true);
    expect(screen.queryByText(/Dimensions, dashboards/)).toBeNull();
    // A zero count is left out; singular for one.
    expect(screen.getByText('Replaces your account & region names (1 account)')).toBeDefined();
  });

  it('hides the Configuration checkbox when there is neither config nor enrichment', async () => {
    await openPreview(new MockCostApi(), { ...MOCK_SHARED_SOURCE_PREVIEW, hasConfig: false, enrichment: null });
    expect(screen.queryByLabelText(/Configuration/)).toBeNull();
    expect(screen.queryByText(/replaces your account/i)).toBeNull();
  });

  it('keeps your own names: unticking Configuration drops config from the pull selection', async () => {
    const api = new MockCostApi();
    const addSpy = vi.spyOn(api, 'addSharedSource');
    const user = await openPreview(api, { ...MOCK_SHARED_SOURCE_PREVIEW, hasConfig: false, enrichment: { accounts: 3, regions: 2 } });

    await user.click(screen.getByLabelText(/Configuration/));
    await user.click(screen.getByText('Pull'));

    await waitFor(() => { expect(addSpy).toHaveBeenCalled(); });
    const selection = addSpy.mock.calls[0]?.[1];
    expect(selection?.sources).not.toContain('config');
    expect(selection?.sources).toContain('daily');
  });

  it('locks the dialog shut while a pull is in flight', async () => {
    const api = new MockCostApi();
    // Hold the pull pending so the blocking state is observable.
    api.addSharedSource = () => new Promise<never>(() => { /* never resolves */ });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithApi(api, <ImportConfigDialog onClose={onClose} onApplied={() => undefined} />);

    await user.type(screen.getByLabelText('Sharing key from a teammate'), 'CGSHARE1-teammate');
    await user.click(screen.getByText('Continue'));
    await waitFor(() => { expect(screen.getByText('Pull')).toBeDefined(); });
    await user.click(screen.getByText('Pull'));

    await waitFor(() => {
      expect(screen.getByText('Keep this window open until the transfer finishes.')).toBeDefined();
    });
    // No close affordance and the other import options are hidden.
    expect(screen.queryByLabelText('Close')).toBeNull();
    expect(screen.queryByText('Choose bundle file…')).toBeNull();
    // Still the named dialog, and neither Escape nor the backdrop closes it.
    const dialog = screen.getByRole('dialog', { name: 'Import configuration' });
    await user.keyboard('{Escape}');
    const backdrop = dialog.querySelector(':scope > [aria-hidden="true"]');
    if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not found');
    await user.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
