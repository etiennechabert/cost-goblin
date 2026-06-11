import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BundleSummaryCard, ImportConfigDialog, ShareConfigDialog } from '../components/config-sharing.js';
import { MOCK_BUNDLE_SUMMARY, MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';

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

  it('prefills the publish destination from the daily CUR bucket root', async () => {
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
    expect(publishSpy).toHaveBeenCalledWith({ location: 's3://costgoblin-cur-bucket/costgoblin/org-config.yaml' });
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
    expect(publishSpy).toHaveBeenCalledWith({ location: 's3://config-bucket/shared/finops.yaml' });
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

    await user.selectOptions(screen.getByLabelText('Your AWS profile'), 'prod');
    await user.click(screen.getByText('Apply configuration'));
    await waitFor(() => {
      expect(screen.getByText('Configuration applied.')).toBeDefined();
    });
    expect(applySpy).toHaveBeenCalledWith({ content: 'kind: costgoblin-config-bundle', profile: 'prod' });

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
    expect(applySpy).toHaveBeenCalledWith({ content: 'kind: costgoblin-config-bundle', profile: 'default' });
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
    await user.selectOptions(screen.getByLabelText('AWS profile'), 'staging');
    await user.clear(input);
    await user.type(input, 's3://client-bucket/costgoblin/org-config.yaml');
    await user.click(screen.getByText('Fetch from S3'));
    await waitFor(() => {
      expect(screen.getByText('Apply configuration')).toBeDefined();
    });
    expect(fetchSpy).toHaveBeenCalledWith({ profile: 'staging', location: 's3://client-bucket/costgoblin/org-config.yaml' });
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
