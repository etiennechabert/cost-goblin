import type { CheckConfigBeaconParams, CheckConfigBeaconResult, CostGoblinConfig } from '@costgoblin/core/browser';
import { asBucketPath } from '@costgoblin/core/browser';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MOCK_GCP_PROVIDER, MOCK_MIXED_PROVIDER_CONFIG, MockCostApi } from '../__fixtures__/mock-api.js';
import { SetupWizard } from '../views/setup-wizard.js';

function renderWizard(props?: { source?: 'daily' | 'hourly' | 'costOptimization'; profile?: string; mode?: 'add'; config?: CostGoblinConfig; providerName?: string; gcpSource?: { bucket: string; prefix: string; impersonateServiceAccount?: string }; prepare?: (api: MockCostApi) => void }) {
  const api = new MockCostApi();
  // Before render: the wizard reads the configured providers on mount.
  if (props?.config !== undefined) vi.spyOn(api, 'getConfig').mockResolvedValue(props.config);
  // Before render, for wizards that start loading on mount (per-tier Configure).
  props?.prepare?.(api);
  const onComplete = vi.fn();
  const user = userEvent.setup();
  return {
    api,
    onComplete,
    user,
    ...render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} source={props?.source} profile={props?.profile} mode={props?.mode} providerName={props?.providerName} gcpSource={props?.gcpSource} />
      </CostApiProvider>,
    ),
  };
}

/** Walk bucket → browse → confirm (the mock always offers my-cur-bucket and a
 *  valid CUR folder; the beacon answers 'none'). */
async function walkToConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
  await userClickText(user, 'my-cur-bucket');
  await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
  await userClickText(user, 'Use this location');
  await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
}

async function userClickText(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(screen.getByText(text));
}

afterEach(cleanup);

describe('SetupWizard', () => {
  it('get started button advances to profile step', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => {
      expect(screen.getByText('default')).toBeDefined();
    });
    expect(screen.getByText('prod')).toBeDefined();
    expect(screen.getByText('staging')).toBeDefined();
  });

  it('shows loading state while fetching profiles', async () => {
    const api = new MockCostApi();
    let resolveProfiles: ((profiles: string[]) => void) | undefined;
    api.listAwsProfiles = () => new Promise<string[]>((resolve) => { resolveProfiles = resolve; });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} />
      </CostApiProvider>,
    );
    await user.click(screen.getByLabelText('Set up from AWS'));
    expect(screen.getByText('Loading profiles...')).toBeDefined();
    resolveProfiles?.(['default']);
    await waitFor(() => {
      expect(screen.getByText('default')).toBeDefined();
    });
  });

  it('renders in source mode when source and profile provided', async () => {
    renderWizard({ source: 'daily', profile: 'default' });
    await waitFor(() => {
      expect(screen.getByText('my-cur-bucket')).toBeDefined();
    });
  });

  it('continues to manual browsing when the bucket has no published config', async () => {
    const { api, user } = renderWizard();
    const beaconSpy = vi.spyOn(api, 'checkConfigBeacon');
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));
    // Default mock beacon answer is 'none' → manual prefix browsing.
    await waitFor(() => { expect(screen.getAllByText('data/').length).toBeGreaterThan(0); });
    expect(beaconSpy).toHaveBeenCalledWith({ profile: 'default', bucket: 'my-cur-bucket' });
  });

  it('surfaces an AWS browse credential failure with a sign-in instead of an empty folder', async () => {
    // The AWS leg used to swallow a browse failure into "No subfolders found"
    // (the exact dead end #539/#542 removed everywhere else). An expired SSO
    // token must now show the message and one-click re-auth.
    const { api, user } = renderWizard();
    api.s3BrowseResult = {
      prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [],
      error: 'Your AWS SSO session has expired. Run `aws sso login` and retry.',
    };
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));
    await waitFor(() => { expect(screen.getByText(/session has expired/)).toBeDefined(); });
    expect(screen.getByText('Open SSO Login')).toBeDefined();
    expect(screen.queryByText('No subfolders found')).toBeNull();
  });

  it('offers a plain Retry when an AWS browse failure is not a credential error', async () => {
    const { api, user } = renderWizard();
    api.s3BrowseResult = {
      prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [],
      error: 'AccessDenied: not authorized to perform s3:ListBucket',
    };
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));
    await waitFor(() => { expect(screen.getByText(/AccessDenied/)).toBeDefined(); });
    expect(screen.getByText('Retry')).toBeDefined();
    expect(screen.queryByText('No subfolders found')).toBeNull();
  });

  it('offers a discovered team configuration and applies it with the chosen profile', async () => {
    const { api, user, onComplete } = renderWizard();
    api.checkConfigBeacon = (params: CheckConfigBeaconParams): Promise<CheckConfigBeaconResult> => Promise.resolve({
      status: 'found',
      location: `s3://${params.bucket}/costgoblin/org-config.yaml`,
      content: 'kind: costgoblin-config-bundle',
      summary: {
        schemaVersion: 1,
        appVersion: '0.2.0',
        exportedAt: '2026-06-01T09:00:00.000Z',
        fingerprint: 'feedfacefeedfacefeedfacefeedface',
        fingerprintValid: true,
        sections: ['config', 'dimensions'],
        providers: [{ name: 'aws-main', dailyBucket: 's3://my-cur-bucket/daily/' }],
        builtInDimensionCount: 7,
        tagDimensionCount: 3,
        orgTreeNodeCount: 0,
        exclusionRuleCount: 0,
        viewCount: 0,
        baselineCount: 0,
      },
    });
    const applySpy = vi.spyOn(api, 'applyConfigBundle');

    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));

    await waitFor(() => { expect(screen.getByText('Team configuration found')).toBeDefined(); });
    expect(screen.getByText('s3://my-cur-bucket/daily/')).toBeDefined();

    await user.click(screen.getByText('Use this configuration'));
    await waitFor(() => { expect(onComplete).toHaveBeenCalledOnce(); });
    expect(applySpy).toHaveBeenCalledWith({ content: 'kind: costgoblin-config-bundle', credentialsProfile: 'default' });
  });

  it('lets the user decline the discovered configuration and set up manually', async () => {
    const { api, user } = renderWizard();
    api.checkConfigBeacon = () => Promise.resolve({
      status: 'found',
      location: 's3://my-cur-bucket/costgoblin/org-config.yaml',
      content: 'kind: costgoblin-config-bundle',
      summary: {
        schemaVersion: 1,
        appVersion: '0.2.0',
        exportedAt: '2026-06-01T09:00:00.000Z',
        fingerprint: 'feedfacefeedfacefeedfacefeedface',
        fingerprintValid: true,
        sections: ['config', 'dimensions'],
        providers: [{ name: 'aws-main', dailyBucket: 's3://my-cur-bucket/daily/' }],
        builtInDimensionCount: 7,
        tagDimensionCount: 3,
        orgTreeNodeCount: 0,
        exclusionRuleCount: 0,
        viewCount: 0,
        baselineCount: 0,
      },
    });

    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));
    await waitFor(() => { expect(screen.getByText('Team configuration found')).toBeDefined(); });

    await user.click(screen.getByText('Set up manually instead'));
    await waitFor(() => { expect(screen.getAllByText('data/').length).toBeGreaterThan(0); });
  });

  it('opens the import dialog from the welcome step', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByText('Import from a teammate'));
    await waitFor(() => { expect(screen.getByText('Choose bundle file…')).toBeDefined(); });
  });

  it('returns to the start screen from a wizard step via the close button', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByLabelText('Back to start'));
    await waitFor(() => { expect(screen.getByText('Import from a teammate')).toBeDefined(); });
  });

  it('does not show the close button on the start screen', () => {
    renderWizard();
    expect(screen.queryByLabelText('Back to start')).toBeNull();
  });
});

// The desktop window has no native title bar (titleBarStyle: hiddenInset), and
// standalone onboarding renders without the app header that normally hosts the
// macOS drag region — so the wizard backdrop must itself be draggable or the
// window can't be moved at all during setup (issue #317).
describe('SetupWizard window drag region', () => {
  it('standalone wizard backdrop is a drag region and the card opts out', () => {
    const { container } = renderWizard();
    expect(container.firstElementChild?.className).toContain('[-webkit-app-region:drag]');
    expect(container.querySelector('[class*="[-webkit-app-region:no-drag]"]')).not.toBeNull();
  });

  it('embedded source mode (Data Management modal) is not a drag region', async () => {
    const { container } = renderWizard({ source: 'daily', profile: 'default' });
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    expect(container.firstElementChild?.className).not.toContain('[-webkit-app-region:drag]');
  });
});

describe('SetupWizard workspace naming', () => {
  it('starts on the naming step with the field prefilled when workspaceNaming is present', () => {
    const api = new MockCostApi();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={vi.fn()} workspaceNaming={{ initialName: 'default' }} />
      </CostApiProvider>,
    );
    expect(screen.getByLabelText('Workspace name')).toHaveProperty('value', 'default');
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false);
  });

  it('Continue leads to the get-started hub showing the typed name', async () => {
    const api = new MockCostApi();
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={vi.fn()} workspaceNaming={{ initialName: 'default' }} />
      </CostApiProvider>,
    );
    const input = screen.getByLabelText('Workspace name');
    await user.clear(input);
    await user.type(input, 'client-a');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => { expect(screen.getByText('Which cloud are you billing on?')).toBeDefined(); });
    expect(screen.getByText('client-a')).toBeDefined();
    // The hub offers the way back to the naming step.
    await user.click(screen.getByText('← Change workspace name'));
    expect(screen.getByLabelText('Workspace name')).toHaveProperty('value', 'client-a');
  });

  it('disables Continue while the name is invalid', async () => {
    const api = new MockCostApi();
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={vi.fn()} workspaceNaming={{ initialName: 'default' }} />
      </CostApiProvider>,
    );
    const input = screen.getByLabelText('Workspace name');
    await user.clear(input);
    await user.type(input, 'bad name!');
    expect(screen.getByText(/letters, digits/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
  });

  // Defense in depth: the host holds the wizard until the workspaces info is
  // loaded, but if the prop ever arrives after mount anyway, the name state
  // must still pick up the initial name instead of staying empty+invalid.
  it('seeds the name state when workspaceNaming arrives after mount', async () => {
    const api = new MockCostApi();
    const onComplete = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} />
      </CostApiProvider>,
    );
    expect(screen.queryByLabelText('Workspace name')).toBeNull();
    rerender(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} workspaceNaming={{ initialName: 'default' }} />
      </CostApiProvider>,
    );
    // The wizard stays on the hub (it mounted without a naming step), but the
    // way back to naming appears and the field arrives seeded.
    await user.click(await screen.findByText('← Change workspace name'));
    await waitFor(() => {
      expect(screen.getByLabelText('Workspace name')).toHaveProperty('value', 'default');
    });
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('SetupWizard jump-back to existing workspaces', () => {
  it('lists other workspaces and switches on click', async () => {
    const api = new MockCostApi();
    const switchSpy = vi.spyOn(api, 'switchWorkspace');
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={vi.fn()} workspaceLabel="client-b" otherWorkspaces={['default', 'prod']} />
      </CostApiProvider>,
    );
    expect(screen.getByText('Jump back into an existing workspace:')).toBeDefined();
    expect(screen.getByText('client-b')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'prod' }));
    await waitFor(() => { expect(switchSpy).toHaveBeenCalledWith('prod'); });
  });

  it('shows no jump-back section without other workspaces', () => {
    const api = new MockCostApi();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={vi.fn()} />
      </CostApiProvider>,
    );
    expect(screen.queryByText('Jump back into an existing workspace:')).toBeNull();
  });

  it('source mode targets the first configured provider with a fixed name', async () => {
    const { api, user, onComplete } = renderWizard({ source: 'daily', profile: 'prod' });
    const writeSpy = vi.spyOn(api, 'writeConfig');
    await walkToConfirm(user);
    // Name comes from the existing config (aws-main) and is not editable.
    expect(screen.queryByLabelText('Provider name')).toBeNull();
    expect(screen.getByText('aws-main')).toBeDefined();
    await user.click(screen.getByText('Complete Setup'));
    await waitFor(() => { expect(onComplete).toHaveBeenCalledOnce(); });
    expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({ providerName: 'aws-main', profile: 'prod' }));
  });

  it('add mode requires a fresh provider name and rejects duplicates', async () => {
    const { api, user, onComplete } = renderWizard({ mode: 'add' });
    const writeSpy = vi.spyOn(api, 'writeConfig');
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('prod')).toBeDefined(); });
    await user.click(screen.getByText('prod'));
    await walkToConfirm(user);

    const nameInput = screen.getByLabelText<HTMLInputElement>('Provider name');
    const completeButton = screen.getByText('Complete Setup').closest('button');
    // A free name is proposed: aws-main is taken in the mock config.
    await waitFor(() => { expect(nameInput.value).toBe('aws-main-2'); });
    expect(completeButton?.disabled).toBe(false);
    // Empty name: cannot complete.
    await user.clear(nameInput);
    expect(completeButton?.disabled).toBe(true);

    // The mock config already has a provider named aws-main — adding it again
    // would silently overwrite it through the upsert, so it must be blocked.
    await user.type(nameInput, 'aws-main');
    await waitFor(() => {
      expect(screen.getByText('A provider named "aws-main" already exists — pick a different name.')).toBeDefined();
    });
    expect(completeButton?.disabled).toBe(true);

    await user.clear(nameInput);
    await user.type(nameInput, 'payer-b');
    await waitFor(() => { expect(completeButton?.disabled).toBe(false); });
    await user.click(screen.getByText('Complete Setup'));
    await waitFor(() => { expect(onComplete).toHaveBeenCalledOnce(); });
    expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({ providerName: 'payer-b' }));
  });
});

describe('SetupWizard — GCP', () => {
  it('offers a Google Cloud door beside AWS and the teammate import', () => {
    // Before this existed, a GCP user reaching the hub had no route at all:
    // the manual escape hatch lives on a screen only reachable AFTER setup
    // completes, so the two AWS-shaped options were the whole world.
    renderWizard();
    expect(screen.getByLabelText('Set up from AWS')).toBeDefined();
    expect(screen.getByLabelText('Set up from Google Cloud')).toBeDefined();
    expect(screen.getByText('Import from a teammate')).toBeDefined();
  });

  it('shows Azure as a visible but disabled tile', async () => {
    // Kept on screen rather than omitted: "Azure is coming" is information,
    // whereas a missing tile reads as a product that never considered it.
    const { user } = renderWizard();
    const azure = screen.getByLabelText('Set up from Azure');
    expect(azure.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Coming soon')).toBeDefined();

    // Clicking it must go nowhere — still on the hub afterwards.
    await user.click(azure);
    expect(screen.getByLabelText('Set up from AWS')).toBeDefined();
  });

  it('sends first-time users to the setup guide before offering to write anything', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    const guide = await screen.findByRole('link', { name: 'Google Cloud setup guide' });
    expect(guide.getAttribute('href')).toBe('https://costgoblin.com/#get-started-gcp');
    // Nothing to restart into yet — the confirm button appears only once the
    // template has actually been written.
    expect(screen.queryByText(/I've saved it/)).toBeNull();
  });

  it('does not overstate what the GCP sign-in can reach', async () => {
    // Approvers decide on a read-only service account from what they read.
    // The full statement lives in the guide; this screen must not contradict
    // it by claiming CostGoblin cannot reach BigQuery.
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await screen.findByRole('link', { name: 'Google Cloud setup guide' });
    expect(screen.queryByText(/reach BigQuery/i)).toBeNull();
  });

  it('scaffolds the GCP arm, not the AWS one', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Write the config by hand instead'));
    // An AWS template here would leave a GCP user deleting a block before the
    // app would start — the friction this step exists to remove.
    await waitFor(() => { expect(api.scaffoldedFor).toEqual(['gcp']); });
  });

  it('only offers the restart once the config exists, then completes', async () => {
    const { api, user, onComplete } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Write the config by hand instead'));
    await waitFor(() => { expect(screen.getByText("I've saved it — restart")).toBeDefined(); });
    // Re-openable without re-scaffolding from scratch — the handler skips
    // files that already exist, so a second press cannot clobber an edit.
    expect(screen.getByText('Open the config folder again')).toBeDefined();
    await user.click(screen.getByText('Open the config folder again'));
    await waitFor(() => { expect(api.scaffoldedFor).toEqual(['gcp', 'gcp']); });

    await user.click(screen.getByText("I've saved it — restart"));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('surfaces a scaffold failure instead of claiming success', async () => {
    const { api, user } = renderWizard();
    api.scaffoldConfig = () => Promise.reject(new Error('EACCES: permission denied'));
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Write the config by hand instead'));
    await waitFor(() => { expect(screen.getByText('EACCES: permission denied')).toBeDefined(); });
    expect(screen.queryByText(/I've saved it/)).toBeNull();
  });

  it('goes back to the hub without completing setup', async () => {
    const { user, onComplete } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(screen.getByLabelText('Set up from AWS')).toBeDefined(); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

/** A live least-privilege reader's verbatim denial, Troubleshooter URL and all
 *  — the length and shape are the reason the panel demotes it rather than
 *  printing it. Mirrors the core suite's constant of the same name. */
const BUCKET_LIST_DENIED =
  'costgoblin-reader@acme-prod.iam.gserviceaccount.com does not have storage.buckets.list access to the Google Cloud project. '
  + "Permission 'storage.buckets.list' denied on resource (or it may not exist). Remediate access with this Troubleshooter URL or "
  + 'share it with your administrator - https://console.cloud.google.com/iam-admin/troubleshooter/summary;errorId=CiQwMTlmZTAwMS01MmYx.';

/** The exporter's layout: gs://bucket/<PREFIX>/<TIER>/billing_period=YYYY-MM/.
 *  Keyed by browse prefix so a test can walk the tree the way a user does. */
function gcpExportLayout(api: MockCostApi): void {
  api.gcsBrowseByPrefix = {
    '': { prefixes: ['focus'], folder: { kind: 'unknown' }, hasParquet: false, truncated: false },
    'focus/': { prefixes: ['daily', 'hourly'], folder: { kind: 'tier-parent', tiers: ['daily', 'hourly'] }, hasParquet: false, truncated: false },
    'focus/daily/': {
      prefixes: ['billing_period=2026-06', 'billing_period=2026-07'],
      folder: { kind: 'export', periods: ['2026-06', '2026-07'] },
      hasParquet: true, truncated: false,
    },
    'focus/hourly/': {
      prefixes: ['billing_period=2026-07'],
      folder: { kind: 'export', periods: ['2026-07'] },
      hasParquet: true, truncated: false,
    },
  };
}

/** Bucket root → focus/daily → Use this location → Confirm (hourly is optional, one ← Back away). */
async function walkGcpDailyToConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await userClickText(user, 'acme-focus-export');
  await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
  await user.click(screen.getByLabelText('Open folder focus'));
  await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
  await user.click(screen.getByLabelText('Open folder daily'));
  await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
  await userClickText(user, 'Use this location');
  await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
}

/** Opens the read-only service account field, which the intro keeps behind
 *  "Change" while it holds the default. */
async function openReaderField(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Change' }));
}

/** Hub → GCP intro → project → bucket → bucket root. */
async function enterGcpBrowse(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByLabelText('Set up from Google Cloud'));
  await user.click(screen.getByText('Choose from my projects'));
  await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
  await userClickText(user, 'Acme Production');
  await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
  await userClickText(user, 'acme-focus-export');
  await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
}

describe('SetupWizard — optional tiers on Confirm', () => {
  it('offers GCP hourly as an optional add, and brings the user back to Confirm', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    // No Cost Optimization on GCP.
    expect(screen.queryByRole('button', { name: 'Add Cost Optimization data' })).toBeNull();

    // Skipping the optional step returns to Confirm, still without hourly.
    await user.click(screen.getByRole('button', { name: 'Add hourly export' }));
    await waitFor(() => { expect(screen.getByText('Skip')).toBeDefined(); });
    await userClickText(user, 'Skip');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(screen.getByRole('button', { name: 'Add hourly export' })).toBeDefined();

    // Adding it lands back on Confirm with the hourly card and its picker.
    await user.click(screen.getByRole('button', { name: 'Add hourly export' }));
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder hourly'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByRole('group', { name: 'Hourly FOCUS export retention' })).toBeDefined(); });
    expect(screen.queryByRole('button', { name: 'Add hourly export' })).toBeNull();
  });

  it('says a tier the provider already has is kept, rather than inviting an add', async () => {
    const config: CostGoblinConfig = {
      providers: [{
        ...MOCK_GCP_PROVIDER,
        sync: {
          daily: { bucket: asBucketPath('gs://acme-focus-export/focus/daily/'), retentionDays: 365 },
          hourly: { bucket: asBucketPath('gs://acme-focus-export/focus/hourly/'), retentionDays: 14 },
          intervalMinutes: 60,
        },
      }],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
    };
    const { api, user } = renderWizard({ config });
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(screen.getByText('gs://acme-focus-export/focus/hourly/')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Change' })).toBeDefined();
  });

  it('offers AWS hourly and Cost Optimization, and Skip on hourly returns to Confirm', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('prod')).toBeDefined(); });
    await user.click(screen.getByText('prod'));
    await walkToConfirm(user);
    expect(screen.getByRole('button', { name: 'Add Cost Optimization data' })).toBeDefined();

    // Skipping hourly used to chain on to the Cost Optimization step.
    await user.click(screen.getByRole('button', { name: 'Add hourly export' }));
    await waitFor(() => { expect(screen.getByText('Skip')).toBeDefined(); });
    await userClickText(user, 'Skip');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
  });

  it('shows no optional tiers in per-tier Configure, which came for one tier', async () => {
    const { user } = renderWizard({ source: 'daily', profile: 'prod' });
    await walkToConfirm(user);
    expect(screen.queryByText('Optional')).toBeNull();
  });

  it('proposes a GCP provider name in add mode, never an aws- one', async () => {
    const { api, user } = renderWizard({ mode: 'add' });
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(screen.getByLabelText<HTMLInputElement>('Provider name').value).toBe('gcp-main');
  });
});

describe('SetupWizard — per-tier Configure on a GCP provider', () => {
  /** gcp-main with its daily tier only, as the wizard (hourly optional) leaves it. */
  const dailyOnlyGcp: CostGoblinConfig = {
    providers: [{
      ...MOCK_GCP_PROVIDER,
      sync: { daily: { bucket: asBucketPath('gs://acme-focus-export/focus/daily/'), retentionDays: 365 }, intervalMinutes: 60 },
    }],
    defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
  };
  const configureHourly = { source: 'hourly' as const, providerName: 'gcp-main', gcpSource: { bucket: 'acme-focus-export', prefix: 'focus/' }, config: dailyOnlyGcp, prepare: gcpExportLayout };

  it('browses and keeps the provider s reader when a tier is configured later', async () => {
    // A provider granted the bucket only through its reader: browsing as the
    // plain sign-in would 403, and writing no reader would drop it.
    const reader = 'costgoblin-reader@acme-prod.iam.gserviceaccount.com';
    const { api, user } = renderWizard({ ...configureHourly, gcpSource: { ...configureHourly.gcpSource, impersonateServiceAccount: reader } });
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder hourly'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    expect(api.gcsBrowsed.length).toBeGreaterThan(0);
    expect(api.gcsBrowsed.every(b => b.impersonateServiceAccount === reader)).toBe(true);
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(screen.getByText(reader)).toBeDefined();
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    expect(api.writtenConfigs[0]?.impersonateServiceAccount).toBe(reader);
  });

  it('adds the hourly tier later, opening in the bucket the daily export lives in', async () => {
    // The AWS tiers had this; on GCP the panel only said to edit the YAML, so
    // skipping hourly during setup meant a hand edit to add it later.
    const listedProjects: string[] = [];
    const { api, user } = renderWizard({
      ...configureHourly,
      // Installed before mount, so a listing fired on mount would be caught.
      prepare: (mock) => {
        gcpExportLayout(mock);
        const list = mock.listGcsBuckets.bind(mock);
        mock.listGcsBuckets = (projectId) => { listedProjects.push(projectId); return list(projectId); };
      },
    });
    // Opens on the daily export's parent — no project, no bucket listing.
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    expect(listedProjects).toEqual([]);
    await user.click(screen.getByLabelText('Open folder hourly'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });

    // The config records no project, so there is none to show.
    expect(screen.queryByText('Google Cloud project')).toBeNull();
    expect(screen.queryByText('Daily FOCUS export')).toBeNull();
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    const written = api.writtenConfigs[0];
    expect(written?.type).toBe('gcp');
    expect(written?.providerName).toBe('gcp-main');
    // Daily absent from the payload: the writer keeps the configured one.
    expect(written?.dailyBucket).toBe('');
    expect(written?.hourlyBucket).toBe('gs://acme-focus-export/focus/hourly/');
    expect(written?.hourlyRetentionDays).toBe(30);
  });

  it('goes ← Back from Confirm to the folder it opened on, with no Skip offered', async () => {
    const { user } = renderWizard(configureHourly);
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    // It came for this one tier; skipping it would only save an unchanged config.
    expect(screen.queryByText('Skip')).toBeNull();
    await user.click(screen.getByLabelText('Open folder hourly'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    // A bucket step could not list without a project; the folder is where the user was.
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
  });

  it('asks the "Signed in as" panel about the provider being configured', async () => {
    // Its impersonateServiceAccount decides who downloads, so the panel has to
    // name it rather than report the bare signed-in identity.
    const { api } = renderWizard(configureHourly);
    await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toContain('gcp-main'); });
  });

  it('refuses the configured daily folder as the hourly one', async () => {
    const { user } = renderWizard(configureHourly);
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Already used by the daily tier')).toBeDefined(); });
  });
});

describe('SetupWizard — GCP browse-and-pick', () => {
  it('lists projects from gcloud, since GCS has no account-wide bucket list', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    expect(screen.getByText('acme-prod')).toBeDefined();
    expect(screen.getByText('Acme Dev')).toBeDefined();
  });

  it('lists the chosen project s buckets', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    // Scoped to the picked project, not some default — the whole reason the
    // project step exists.
    expect(api.gcsBucketsListedFor).toEqual(['acme-prod']);
  });

  it('refuses the exporter PREFIX folder and names the fix', async () => {
    // The single most common GCP misconfiguration: gs://bucket/focus rather
    // than gs://bucket/focus/daily makes the daily tier read hourly shards.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByText('This is the parent folder — go one level deeper')).toBeDefined(); });
    // Nothing to use until a folder is an export: the action lives on the
    // "FOCUS export detected" card, not as a disabled footer button.
    expect(screen.queryByRole('button', { name: 'Use this location' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select an export folder' })).toBeNull();
  });

  it('accepts the tier folder and reports the periods it found', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    expect(screen.getByText('Found 2 billing periods (2026-06 – 2026-07)')).toBeDefined();
    const useIt = screen.getByRole('button', { name: 'Use this location' });
    expect(useIt.hasAttribute('disabled')).toBe(false);
    // On the verdict card that enables it.
    expect(screen.getByText('FOCUS export detected').closest('div.rounded-lg')?.contains(useIt)).toBe(true);
  });

  it('writes a gcp provider with a gs:// path and no AWS profile', async () => {
    const { api, user, onComplete } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');

    // Daily lands straight on Confirm, mirroring the AWS chain: hourly is
    // optional, not a step every user has to skip.
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    // Hourly is offered, visibly optional, not collected.
    expect(screen.queryByRole('group', { name: 'Hourly FOCUS export retention' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add hourly export' })).toBeDefined();
    expect(screen.getByText('Optional')).toBeDefined();

    // The credential card names the GCP project, not an AWS profile that
    // does not exist on this path.
    expect(screen.getByText('Google Cloud project')).toBeDefined();
    expect(screen.queryByText('AWS Profile')).toBeNull();

    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(onComplete).toHaveBeenCalledOnce(); });

    const written = api.writtenConfigs[0];
    expect(written?.type).toBe('gcp');
    expect(written?.dailyBucket).toBe('gs://acme-focus-export/focus/daily/');
    expect(written?.profile).toBe('');
    // GCP has no Cost Optimization Hub analogue and validateGcpSync rejects
    // the key — the wizard must never send one.
    expect(written?.costOptBucket).toBeUndefined();
  });

  it('browses and writes as the read-only service account named on the intro step', async () => {
    // ADC is one machine-wide login; the reader is per provider. Naming it
    // here makes the wizard browse as exactly the identity the sync will use.
    const reader = 'costgoblin-reader@acme-prod.iam.gserviceaccount.com';
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    await user.type(screen.getByLabelText('Read-only service account'), reader);
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcsBucketsListedAs).toEqual([reader]);

    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    expect(api.gcsBrowsed.map(b => b.impersonateServiceAccount)).toEqual([reader, reader, reader]);

    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(screen.getByText('Reads as')).toBeDefined();
    expect(screen.getByText(reader)).toBeDefined();

    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    expect(api.writtenConfigs[0]?.impersonateServiceAccount).toBe(reader);
  });

  it('browses, checks and saves as the user s own login when the reader field is cleared', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    expect(api.gcsBucketsListedAs).toEqual([undefined]);
    expect(api.gcsBrowsed.every(b => b.impersonateServiceAccount === undefined)).toBe(true);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(screen.queryByText('Reads as')).toBeNull();
    await waitFor(() => { expect(screen.getByText('gcloud can read this export as your gcloud account')).toBeDefined(); });
    expect(api.gcsDownloadChecks).toEqual([{ bucketPath: 'gs://acme-focus-export/focus/daily/' }]);
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    // '' — not omitted: the field showed the default reader and the user
    // emptied it, which is a decision to read as themselves.
    expect(api.writtenConfigs[0]?.impersonateServiceAccount).toBe('');
  });

  it('prefills the reader of the provider this run reconfigures, and clears it when emptied', async () => {
    const reader = 'old-reader@acme-prod.iam.gserviceaccount.com';
    const gcpMain = MOCK_GCP_PROVIDER;
    if (gcpMain.type !== 'gcp') throw new Error('MOCK_GCP_PROVIDER must be a gcp provider');
    const spy = vi.spyOn(MockCostApi.prototype, 'getConfig').mockResolvedValue({
      ...MOCK_MIXED_PROVIDER_CONFIG,
      providers: [{ ...gcpMain, impersonateServiceAccount: reader }],
    });
    try {
      const { api, user } = renderWizard();
      gcpExportLayout(api);
      await user.click(screen.getByLabelText('Set up from Google Cloud'));
      const field = screen.getByLabelText('Read-only service account');
      await waitFor(() => { expect(screen.getByDisplayValue(reader)).toBe(field); });

      await user.clear(field);
      await user.click(screen.getByText('Choose from my projects'));
      await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
      await userClickText(user, 'Acme Production');
      await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
      expect(api.gcsBucketsListedAs).toEqual([undefined]);

      // Emptying a reader the wizard showed IS a decision: written as ''.
      await walkGcpDailyToConfirm(user);
      await userClickText(user, 'Complete Setup');
      await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
      expect(api.writtenConfigs[0]?.impersonateServiceAccount).toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  it('forgets the reader when the user abandons the run with the close button', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    await user.type(screen.getByLabelText('Read-only service account'), 'reader@acme-prod.iam.gserviceaccount.com');
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await user.click(screen.getByLabelText('Back to start'));
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    // Back to the default, not to the typed reader — and folded away again.
    expect(screen.getByLabelText('Read-only service account')).toBe(screen.getByDisplayValue('costgoblin-reader'));
    expect(screen.getByRole('button', { name: 'Change' })).toBeDefined();
  });

  it('holds the browse back on an address that is not a service account', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    await user.type(screen.getByLabelText('Read-only service account'), 'me@gmail.com');
    expect(screen.getByText(/^Use an account name like costgoblin-reader, or .*name@project\.iam\.gserviceaccount\.com/)).toBeDefined();
    const find = screen.getByRole('button', { name: 'Choose from my projects' });
    expect(find.hasAttribute('disabled')).toBe(true);
    await user.click(find);
    // Nor through a typed project: Continue stays off, and Enter goes nowhere.
    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod{Enter}');
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(api.gcsBucketsListedFor).toEqual([]);
  });

  /** Walks the GCP flow through BOTH tiers to the Confirm step: daily lands
   *  on Confirm, and ← Back from there is the way to the optional hourly
   *  tier — the same shape as the AWS chain. */
  async function walkGcpBothTiersToConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder hourly'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
  }

  it('collects the hourly tier when the exporter publishes one', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await walkGcpBothTiersToConfirm(user);
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });

    const written = api.writtenConfigs[0];
    expect(written?.dailyBucket).toBe('gs://acme-focus-export/focus/daily/');
    expect(written?.hourlyBucket).toBe('gs://acme-focus-export/focus/hourly/');
  });

  it('sets each tier retention in its own card instead of one shared picker', async () => {
    // One shared picker configured only the daily tier; hourly silently took
    // its default, and the two need very different windows.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await walkGcpBothTiersToConfirm(user);

    const daily = screen.getByRole('group', { name: 'Daily FOCUS export retention' });
    const hourly = screen.getByRole('group', { name: 'Hourly FOCUS export retention' });
    // Each tier starts on its own default, with its own range of choices.
    expect(within(daily).getByRole('button', { name: '12 months', pressed: true })).toBeDefined();
    expect(within(hourly).getByRole('button', { name: '30 days', pressed: true })).toBeDefined();
    expect(within(hourly).queryByRole('button', { name: '2 years' })).toBeNull();

    await user.click(within(daily).getByRole('button', { name: '2 years' }));
    await user.click(within(hourly).getByRole('button', { name: '14 days' }));
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });

    const written = api.writtenConfigs[0];
    expect(written?.retentionDays).toBe(730);
    expect(written?.hourlyRetentionDays).toBe(14);
  });

  /** A configured gcp-main the GCP walk lands on, with tuned retention
   *  windows (hourly 60 is not one of the presets). */
  function existingGcpConfig(): CostGoblinConfig {
    return {
      providers: [{
        ...MOCK_GCP_PROVIDER,
        sync: {
          daily: { bucket: asBucketPath('gs://acme-focus-export/focus/daily/'), retentionDays: 730 },
          hourly: { bucket: asBucketPath('gs://acme-focus-export/focus/hourly/'), retentionDays: 60 },
          intervalMinutes: 60,
        },
      }],
      defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
    };
  }

  it('shows and keeps the retention windows a re-run provider already has', async () => {
    // The pickers used to start on the defaults, so re-running setup silently
    // cut a tuned hourly window to 30 days.
    const { api, user } = renderWizard({ config: existingGcpConfig() });
    gcpExportLayout(api);
    await walkGcpBothTiersToConfirm(user);

    const daily = screen.getByRole('group', { name: 'Daily FOCUS export retention' });
    const hourly = screen.getByRole('group', { name: 'Hourly FOCUS export retention' });
    expect(within(daily).getByRole('button', { name: '2 years', pressed: true })).toBeDefined();
    // Off-preset, it still shows — pressed — rather than snapping to 30.
    expect(within(hourly).getByRole('button', { name: '60 days', pressed: true })).toBeDefined();

    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    const written = api.writtenConfigs[0];
    expect(written?.retentionDays).toBe(730);
    expect(written?.hourlyRetentionDays).toBe(60);
  });

  it('keeps the retention picks across Back', async () => {
    // ← Back is how an optional tier is added, and the picks lived in the
    // Confirm step's own state, so going there and back reset them.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await walkGcpBothTiersToConfirm(user);

    await user.click(within(screen.getByRole('group', { name: 'Daily FOCUS export retention' })).getByRole('button', { name: '2 years' }));
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('Skip')).toBeDefined(); });
    await userClickText(user, 'Skip');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });

    expect(within(screen.getByRole('group', { name: 'Daily FOCUS export retention' })).getByRole('button', { name: '2 years', pressed: true })).toBeDefined();
  });

  it('refuses an hourly tier that overlaps the daily one', async () => {
    // validateGcpSync rejects overlapping tiers at load, so letting this
    // through would write a config the app then refuses to start on.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });

    // ← Back to the optional hourly leg, then walk into the SAME daily folder.
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));

    await waitFor(() => { expect(screen.getByText('Already used by the daily tier')).toBeDefined(); });
    expect(screen.queryByRole('button', { name: 'Use this location' })).toBeNull();
  });

  it('defaults the provider name to the gcp arm, not aws-main', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    expect(api.writtenConfigs[0]?.providerName).toBe('gcp-main');
  });

  it('refuses an export whose period folders hold no shards yet', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBrowseByPrefix['focus/daily/'] = {
      prefixes: ['billing_period=2026-07'],
      folder: { kind: 'export', periods: ['2026-07'] },
      hasParquet: false, truncated: false,
    };
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('No Parquet files in this export yet')).toBeDefined(); });
    expect(screen.queryByRole('button', { name: 'Use this location' })).toBeNull();
  });

  it('offers an inline sign-in when listing projects fails on credentials', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [], error: 'You do not currently have an active account' };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('You do not currently have an active account')).toBeDefined(); });
    expect(screen.getByText('Sign in the gcloud CLI')).toBeDefined();
  });

  it('explains a missing gcloud CLI rather than showing the sentinel', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [], error: 'GCLOUD_CLI_NOT_FOUND' };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText(/Google Cloud CLI \(gcloud\) is not installed/)).toBeDefined(); });
    expect(screen.queryByText('GCLOUD_CLI_NOT_FOUND')).toBeNull();
  });

  it('surfaces a browse failure with a sign-in instead of an empty folder', async () => {
    const { api, user } = renderWizard();
    api.gcsBrowseResult = {
      prefixes: [],
      folder: { kind: 'unknown' },
      hasParquet: false,
      truncated: false,
      error: 'Could not load the default credentials',
    };
    // Walked by hand rather than via enterGcpBrowse: a failing browse renders
    // no folders, so that helper's wait for one would burn the test budget.
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByText('Could not load the default credentials')).toBeDefined(); });
    // A credential failure is the common case, so the fix is offered inline
    // rather than leaving the user on an empty folder list.
    expect(screen.getByText('Open Google Sign-in')).toBeDefined();
  });

  it('keeps the hand-written config route available from the project step', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Write the config by hand instead');
    await screen.findByRole('link', { name: 'Google Cloud setup guide' });
    await userClickText(user, 'Write the config by hand instead');
    await waitFor(() => { expect(api.scaffoldedFor).toEqual(['gcp']); });
  });

  it('does not carry an AWS hourly path into a gcp provider', async () => {
    // collectedPaths is shared by both chains. A stale s3:// hourly path
    // reaching a type:'gcp' write produces a config validateGcsSyncTier
    // refuses on the next launch — setup "succeeds", the app won't start.
    const { api, user } = renderWizard();
    gcpExportLayout(api);

    // AWS leg: daily, then hourly, collecting two s3:// paths.
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await userClickText(user, 'default');
    await walkToConfirm(user);

    // Back out to the hub and run GCP instead.
    await user.click(screen.getByLabelText('Back to start'));
    await waitFor(() => { expect(screen.getByLabelText('Set up from Google Cloud')).toBeDefined(); });
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });

    const written = api.writtenConfigs[0];
    expect(written?.type).toBe('gcp');
    expect(written?.hourlyBucket).toBeUndefined();
    expect(written?.dailyBucket.startsWith('gs://')).toBe(true);
  });

  it('does not flag the ancestors of the daily path as overlapping', async () => {
    // gcsTiersOverlap is symmetric containment, so every ancestor of the daily
    // folder matched it. The hourly browse opened on a red "already used"
    // banner, contradicting the "go one level deeper" banner beside it.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    await userClickText(user, '← Back');

    // Now on the hourly leg. The bucket root and focus/ are ancestors of the
    // daily path but are not themselves selectable exports.
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    expect(screen.queryByText('Already used by the daily tier')).toBeNull();
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    expect(screen.queryByText('Already used by the daily tier')).toBeNull();
  });

  it('tells the user to skip when the exporter publishes no hourly tier', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBrowseByPrefix['focus/'] = {
      prefixes: ['daily'],
      folder: { kind: 'tier-parent', tiers: ['daily'] },
      hasParquet: false,
      truncated: false,
    };
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder focus'));
    // Naming a folder that isn't there sent the user looking for it.
    await waitFor(() => { expect(screen.getByText(/publishes no hourly tier/)).toBeDefined(); });
  });

  it('offers the install link, not a sign-in, when gcloud is missing', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [], error: 'GCLOUD_CLI_NOT_FOUND' };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText(/is not installed/)).toBeDefined(); });
    // The login button cannot run a CLI that isn't installed; offering it made
    // the user click something guaranteed to fail to reach the real remedy.
    expect(screen.queryByText('Sign in the gcloud CLI')).toBeNull();
    expect(screen.getByText('Install the gcloud CLI')).toBeDefined();
  });

  it('lets the user type a bucket name when listing buckets is forbidden', async () => {
    // The exporter README's least-privilege recipe grants objectViewer on the
    // bucket, which cannot enumerate buckets — browsing objects still works.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBucketsResult = { buckets: [], error: 'does not have storage.buckets.list access' };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByLabelText('Or enter a bucket name directly')).toBeDefined(); });
    await user.type(screen.getByLabelText('Or enter a bucket name directly'), 'acme-focus-export');
    await userClickText(user, 'Browse');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
  });

  it('explains a forbidden bucket listing instead of dumping the raw denial', async () => {
    // Verified against a live least-privilege reader: objectViewer on the
    // bucket denies storage.buckets.list while every later step succeeds. The
    // raw sentence made that working setup look broken — 400 characters
    // ending in a Troubleshooter URL, over "No buckets found".
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBucketsResult = { buckets: [], error: BUCKET_LIST_DENIED };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');

    await waitFor(() => { expect(screen.getByText(/can't list the buckets in/i)).toBeDefined(); });
    // One line naming the refused reader, not "this account".
    expect(screen.getByRole('status').textContent).toMatch(/^costgoblin-reader can't list the buckets in acme-prod — enter the bucket name below\./);
    // A status, not an alert: with the recommended reader this is the normal path.
    expect(screen.queryByRole('alert')).toBeNull();
    // The fixture DOES contain the Troubleshooter URL — the point is that the
    // wall of text is demoted into the disclosure rather than deleted. GCP
    // returns this same denial when the credential has no access to the
    // project at all, and the principal it names is the only evidence of which
    // identity ADC resolved to, so it has to stay recoverable.
    const raw = screen.getByText(BUCKET_LIST_DENIED);
    expect(raw.closest('details')).not.toBeNull();
    expect(screen.getByText('Details')).toBeDefined();
    // The empty list must not be reported as a missing export...
    expect(screen.queryByText('No buckets found')).toBeNull();
    // ...and the grant the panel discloses is applied in a terminal, so the
    // user needs a way to re-list without backing out of the step.
    expect(screen.getByText('Retry')).toBeDefined();
    // The panel already says all of this; the long label repeated it verbatim
    // one field lower, which read as a second, separate failure.
    expect(screen.getByLabelText('Or enter a bucket name directly')).toBeDefined();
  });

  it('keeps the details open across a retry', async () => {
    // The panel's own flow is: read the principal out of Details, run the
    // grant in a terminal, press Retry. Retry clears `error`, which unmounts
    // the panel — so with the open state held inside it, the disclosure
    // collapsed on every attempt of the loop the copy tells the user to run.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBucketsResult = { buckets: [], error: BUCKET_LIST_DENIED };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');

    await waitFor(() => { expect(screen.getByText(/can't list the buckets in/i)).toBeDefined(); });
    await userClickText(user, 'Details');
    expect(screen.getByText(BUCKET_LIST_DENIED).closest('details')?.open).toBe(true);

    await userClickText(user, 'Retry');
    await waitFor(() => { expect(screen.getByText(/can't list the buckets in/i)).toBeDefined(); });
    expect(screen.getByText(BUCKET_LIST_DENIED).closest('details')?.open).toBe(true);
  });

  it('does not hide buckets behind a filter whose input is gone', async () => {
    // `filter` outlives the input, which only renders above 5 buckets. A
    // filter typed against a long list then kept hiding a short one after a
    // re-list, with no box left on screen to clear it.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBucketsResult = { buckets: Array.from({ length: 6 }, (_, i) => ({ name: `acme-bucket-${String(i)}` })), error: '' };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');

    await waitFor(() => { expect(screen.getByPlaceholderText('Filter buckets...')).toBeDefined(); });
    await user.type(screen.getByPlaceholderText('Filter buckets...'), 'zzz');
    expect(screen.getByText('No buckets match that filter')).toBeDefined();

    // Re-list returns few enough buckets that the filter input unmounts.
    api.gcsBucketsResult = { buckets: [{ name: 'acme-focus-export' }], error: '' };
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');

    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(screen.queryByPlaceholderText('Filter buckets...')).toBeNull();
    expect(screen.queryByText('No buckets match that filter')).toBeNull();
  });

  it('still offers the plain error panel for a non-listing failure', async () => {
    // Both denial tests route to GcpBucketListDenied, which left GcpError on
    // this step with no coverage at all — and losing its retry/sign-in
    // affordances is a regression this repo has already shipped once.
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBucketsResult = { buckets: [], error: 'connect ETIMEDOUT 142.250.74.208:443' };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');

    await waitFor(() => { expect(screen.getByText(/ETIMEDOUT/)).toBeDefined(); });
    expect(screen.getByText('Retry')).toBeDefined();
    expect(screen.queryByText(/least-privilege reader/i)).toBeNull();
    // Not a permissions refusal, so the absence IS the honest report here.
    expect(screen.getByText('No buckets found')).toBeDefined();
  });

  it('keeps the aws-main default when the user backs out of the GCP chain', async () => {
    // Retargeting the name on entry was one-way: an AWS provider ended up
    // named gcp-main, which becomes its data folder and dimension label.
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('Choose from my projects')).toBeDefined(); });
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByLabelText('Set up from AWS')).toBeDefined(); });

    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await userClickText(user, 'default');
    await walkToConfirm(user);
    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    expect(api.writtenConfigs[0]?.providerName).toBe('aws-main');
  });

  it('warns when the folder listing was truncated', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsBrowseByPrefix[''] = { prefixes: ['focus'], folder: { kind: 'unknown' }, hasParquet: false, truncated: true };
    await enterGcpBrowse(user);
    // Presenting a partial listing as complete makes an export past the cut
    // look absent, with nothing to tell the user why.
    await waitFor(() => { expect(screen.getByText('Showing the first folders only')).toBeDefined(); });
  });

  it('walks back from the project step to the GCP intro', async () => {
    const { user, onComplete } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('Choose from my projects')).toBeDefined(); });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('SetupWizard — GCP "Signed in as" panel', () => {
  function signedInPanel(): HTMLElement | null {
    return screen.queryByRole('region', { name: 'Signed in as' });
  }

  it('shows on every GCP step that touches credentials, and nowhere else', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    expect(signedInPanel()).toBeNull();

    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await waitFor(() => { expect(signedInPanel()).not.toBeNull(); });

    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    expect(signedInPanel()).not.toBeNull();
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(signedInPanel()).not.toBeNull();
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    expect(signedInPanel()).not.toBeNull();

    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    expect(signedInPanel()).toBeNull();
    // ← Back opens the optional hourly leg, which touches credentials again.
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('Skip')).toBeDefined(); });
    expect(signedInPanel()).not.toBeNull();
  });

  it('asks without a provider name — none exists yet — and does not re-run gcloud per step', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcpIdentitiesRequestedFor).toHaveLength(1);
    expect(api.gcpIdentitiesRequestedFor[0]).toBeUndefined();
  });

  it('never asks about an AWS provider s name after backing out of its Configure into Google Cloud', async () => {
    // AWS per-tier Configure (source mode) fixes the provider name; Back →
    // Back still reaches the hub's Google Cloud tile.
    const { api, user } = renderWizard({ source: 'daily', profile: 'default' });
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.queryByText('my-cur-bucket')).toBeNull(); });
    await userClickText(user, '← Back');
    await user.click(await screen.findByLabelText('Set up from Google Cloud'));
    await waitFor(() => { expect(signedInPanel()).not.toBeNull(); });
    await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toHaveLength(1); });
    expect(api.gcpIdentitiesRequestedFor[0]).toBeUndefined();
  });

  it('flags, in one line, gcloud being switched to another account on the project step', async () => {
    const { api, user } = renderWizard();
    api.gcpIdentitiesResult = {
      status: 'ok',
      identities: {
        listing: { kind: 'user', file: { path: '/adc.json', origin: 'well-known' }, account: { status: 'known', email: 'alice@acme.com' } },
        download: { kind: 'gcloud', principal: { kind: 'account', account: 'admin@acme.com', fromEnv: false }, impersonate: null, configuration: 'admin' },
        adcLoginPath: null,
        gcloudImpersonation: null,
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadPrincipal: { kind: 'account', account: 'admin@acme.com', fromEnv: false }, sharedTarget: null }],
        notes: [],
      },
    };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    const panel = await screen.findByRole('region', { name: 'Signed in as' });
    await waitFor(() => { expect(panel.textContent).toContain('admin@acme.com'); });
    expect(panel.textContent).toContain('Bucket access is signed in as alice@acme.com — a different account.');
  });

  it('re-reads the identities when the browse step is retried after a sign-in', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    api.gcsBrowseByPrefix = {
      ...api.gcsBrowseByPrefix,
      'focus/': { prefixes: [], folder: { kind: 'unknown' }, hasParquet: false, truncated: false, error: 'Could not load the default credentials.' },
    };
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByText('Could not load the default credentials.')).toBeDefined(); });
    const before = api.gcpIdentitiesRequestedFor.length;
    // Plain navigation never re-reads the panel...
    expect(before).toBe(1);
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    // ...a Retry does: it usually follows the sign-in the error offered.
    await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toHaveLength(before + 1); });
  });

  it('re-reads the identities when a step is retried', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [], error: 'ERROR: (gcloud.projects.list) You do not currently have an active account selected.' };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Retry')).toBeDefined(); });
    const before = api.gcpIdentitiesRequestedFor.length;
    await userClickText(user, 'Retry');
    await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toHaveLength(before + 1); });
  });
});

/** Hub → GCP intro → project step, waiting until the listing has settled. */
async function enterGcpProjectStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByLabelText('Set up from Google Cloud'));
  await user.click(screen.getByText('Choose from my projects'));
  await waitFor(() => { expect(screen.queryByText('Loading projects...')).toBeNull(); });
}

/** Hub → GCP intro → typed project ID → daily bucket step, never listing projects. */
async function enterGcpBucketFromIntro(user: ReturnType<typeof userEvent.setup>, projectId: string): Promise<void> {
  await user.click(screen.getByLabelText('Set up from Google Cloud'));
  await user.type(screen.getByLabelText('Google Cloud project'), `${projectId}{Enter}`);
  await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
}

/** A `listGcpProjects` that stays pending until the test settles it — the
 *  large-organisation case, where the listing takes many seconds. */
function deferProjectListing(api: MockCostApi): { settle: () => Promise<void> } {
  let resolve: ((r: { projects: readonly { projectId: string; name: string }[] }) => void) | undefined;
  api.listGcpProjects = () => new Promise((r) => { resolve = r; });
  return {
    // Inside act, so a late setWizard that escaped the step token would be
    // rendered before the test asserts — not left to scheduler timing.
    settle: async () => {
      await act(async () => {
        resolve?.({ projects: [{ projectId: 'acme-prod', name: 'Acme Production' }] });
        await Promise.resolve();
      });
    },
  };
}

const PROJECT_ID_RULES = /6–30 lowercase letters, digits or hyphens/;

describe('SetupWizard — GCP project typed by ID', () => {
  // The documented least-privilege user holds only Token Creator on the
  // read-only reader, so `gcloud projects list` returns nothing — typing the
  // ID is the only way past this step without an admin granting roles/browser.
  it('offers the ID entry when no project is listed, and submits it with Continue', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [] };
    await enterGcpProjectStep(user);

    expect(screen.getByText('No Google Cloud projects found')).toBeDefined();
    expect(screen.getByText(/can.t list the project/)).toBeDefined();
    await user.type(screen.getByLabelText('Project not listed? Enter its ID'), 'billing-504501');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcsBucketsListedFor).toEqual(['billing-504501']);
  });

  it('keeps the ID entry beside a populated list', async () => {
    const { api, user } = renderWizard();
    await enterGcpProjectStep(user);

    expect(screen.getByText('Acme Production')).toBeDefined();
    // The empty-list explanation belongs to the empty list only.
    expect(screen.queryByText(/can.t list the project/)).toBeNull();
    await user.type(screen.getByLabelText('Project not listed? Enter its ID'), 'unlisted-project{Enter}');

    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcsBucketsListedFor).toEqual(['unlisted-project']);
  });

  it('trims surrounding whitespace from a pasted ID', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [] };
    await enterGcpProjectStep(user);

    await user.click(screen.getByLabelText('Project not listed? Enter its ID'));
    await user.paste('  acme-billing \n');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => { expect(api.gcsBucketsListedFor).toEqual(['acme-billing']); });
  });

  // The rule table itself is pinned in core's gcp-project-id.test.ts; these
  // are the mistakes only the UI can make — chiefly typing the display name.
  it.each([
    ['a display name', 'Acme Production'],
    // Typed key by key: a per-keystroke trim used to delete each space while
    // it was still trailing, collapsing this into the valid-looking `billingexport`.
    ['a lowercase display name with a space', 'billing export'],
    ['a trailing hyphen', 'acme-prod-'],
  ])('refuses %s', async (_why, id) => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [] };
    await enterGcpProjectStep(user);

    const input = screen.getByLabelText('Project not listed? Enter its ID');
    await user.type(input, `${id}{Enter}`);

    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(PROJECT_ID_RULES)).toBeDefined();
    expect(api.gcsBucketsListedFor).toEqual([]);
    expect(screen.getByText('Google Cloud project')).toBeDefined();
  });

  it('does not flag an ID while it is still being typed', async () => {
    // `b`, `bi` … `billing-` are all invalid on the way to a valid ID; red on
    // every one of them is noise, so the rule appears on Enter or on blur.
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [] };
    await enterGcpProjectStep(user);

    const input = screen.getByLabelText('Project not listed? Enter its ID');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    await user.type(input, 'billing-');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText(PROJECT_ID_RULES)).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);

    await user.tab();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(PROJECT_ID_RULES)).toBeDefined();
  });

  it('does not submit on the Enter that commits an IME composition', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [] };
    await enterGcpProjectStep(user);

    const input = screen.getByLabelText('Project not listed? Enter its ID');
    await user.type(input, 'billing');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(api.gcsBucketsListedFor).toEqual([]);
  });

  it('still offers the ID entry when listing projects failed', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [], error: 'GCLOUD_CLI_NOT_FOUND' };
    await enterGcpProjectStep(user);

    await waitFor(() => { expect(screen.getByText(/Google Cloud CLI \(gcloud\) is not installed/)).toBeDefined(); });
    await user.type(screen.getByLabelText('Project not listed? Enter its ID'), 'acme-billing{Enter}');
    await waitFor(() => { expect(api.gcsBucketsListedFor).toEqual(['acme-billing']); });
  });

  it('explains a listing timeout without offering a sign-in', async () => {
    // Thousands of projects outlast the 20 s ceiling. The old message carried
    // `gcloud auth login`, which classified a latency problem as a credential
    // one and offered a sign-in that could not help.
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [], error: 'GCLOUD_PROJECTS_TIMEOUT' };
    await enterGcpProjectStep(user);

    await waitFor(() => { expect(screen.getByText(/Listing your projects timed out/)).toBeDefined(); });
    expect(screen.queryByText('GCLOUD_PROJECTS_TIMEOUT')).toBeNull();
    expect(screen.queryByText('Sign in the gcloud CLI')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
    expect(screen.getByLabelText('Project not listed? Enter its ID')).toBeDefined();
  });

  it('walks back from a typed project to the intro, not into a fresh listing', async () => {
    const { api, user } = renderWizard();
    api.gcpProjectsResult = { projects: [] };
    await enterGcpProjectStep(user);
    const listSpy = vi.spyOn(api, 'listGcpProjects');

    await user.type(screen.getByLabelText('Project not listed? Enter its ID'), 'acme-billing{Enter}');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(screen.getByText('Choose from my projects')).toBeDefined(); });
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('SetupWizard — GCP project ID before the listing', () => {
  // An organisation with thousands of projects waits a long time on
  // `gcloud projects list` for a list nobody can scan — the ID has to be
  // enterable without it.
  it('takes the project ID on the intro step, never lists projects, and walks back to the intro', async () => {
    const { api, user } = renderWizard();
    const listSpy = vi.spyOn(api, 'listGcpProjects');
    await enterGcpBucketFromIntro(user, 'billing-504501');
    expect(api.gcsBucketsListedFor).toEqual(['billing-504501']);

    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(screen.getByText('Choose from my projects')).toBeDefined(); });
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('refuses a malformed ID on the intro step', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));

    await user.type(screen.getByLabelText('Google Cloud project'), 'Acme Prod{Enter}');
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    expect(api.gcsBucketsListedFor).toEqual([]);
  });

  it('still walks back to the listing when the project was picked from it', async () => {
    // The typed route must not leak into a later run through the list.
    const { api, user } = renderWizard();
    await enterGcpBucketFromIntro(user, 'billing-504501');
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(screen.getByText('Choose from my projects')).toBeDefined(); });

    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    expect(api.gcsBucketsListedFor).toEqual(['billing-504501', 'acme-prod']);
  });

  it('accepts a typed ID while the project list is still loading', async () => {
    const { api, user } = renderWizard();
    const listing = deferProjectListing(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    expect(screen.getByText('Loading projects...')).toBeDefined();

    await user.type(screen.getByLabelText('Project not listed? Enter its ID'), 'billing-504501{Enter}');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });

    // The listing finishing late must not drag the wizard back to the project step.
    await listing.settle();
    expect(screen.getByText('acme-focus-export')).toBeDefined();
    expect(screen.queryByText('Acme Production')).toBeNull();
    expect(api.gcsBucketsListedFor).toEqual(['billing-504501']);
  });

  it('is not pulled back to the project step by a listing it walked away from', async () => {
    // "Write the config by hand instead" mid-listing, then start typing on the
    // intro: a late listing used to land and discard what was typed.
    const { api, user } = renderWizard();
    const listing = deferProjectListing(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await user.click(screen.getByText('Write the config by hand instead'));
    await waitFor(() => { expect(screen.getByText('Choose from my projects')).toBeDefined(); });
    await user.type(screen.getByLabelText('Google Cloud project'), 'billing');

    await listing.settle();
    expect(screen.getByText('Choose from my projects')).toBeDefined();
    expect(screen.queryByText('Acme Production')).toBeNull();
    expect(screen.getByDisplayValue('billing')).toBeDefined();
  });

  it('is not pulled off the hub by a listing it backed out of', async () => {
    const { api, user } = renderWizard();
    const listing = deferProjectListing(api);
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await user.click(screen.getByText('Write the config by hand instead'));
    await waitFor(() => { expect(screen.getByText('Choose from my projects')).toBeDefined(); });
    await user.click(screen.getByText('← Back'));
    await waitFor(() => { expect(screen.getByLabelText('Set up from AWS')).toBeDefined(); });

    await listing.settle();
    expect(screen.getByLabelText('Set up from AWS')).toBeDefined();
  });

  it('is not pulled back from Confirm by an hourly bucket listing it skipped', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBucketFromIntro(user, 'billing-504501');
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });

    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });

    // ← Back opens the optional hourly leg, whose bucket listing stays
    // pending while the user skips it.
    let resolveBuckets: ((r: { buckets: readonly { name: string }[] }) => void) | undefined;
    api.listGcsBuckets = () => new Promise((r) => { resolveBuckets = r; });
    await userClickText(user, '← Back');
    await waitFor(() => { expect(screen.getByText('Skip')).toBeDefined(); });
    await userClickText(user, 'Skip');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });

    await act(async () => {
      resolveBuckets?.({ buckets: [{ name: 'acme-focus-export' }] });
      await Promise.resolve();
    });
    expect(screen.getByText('Confirm Setup')).toBeDefined();
  });
});

const DEFAULT_READER = 'costgoblin-reader@acme-prod.iam.gserviceaccount.com';
const DAILY_EXPORT = 'gs://acme-focus-export/focus/daily/';
const HOURLY_EXPORT = 'gs://acme-focus-export/focus/hourly/';

function completeSetupButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Complete Setup' });
}

describe('SetupWizard — GCP default reader', () => {
  it('prefills the account the setup guide creates, and says the project completes it', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    expect(screen.getByLabelText('Read-only service account')).toBe(screen.getByDisplayValue('costgoblin-reader'));
    expect(screen.getByText('costgoblin-reader in the project you pick')).toBeDefined();
    await openReaderField(user);
    expect(screen.getByText(/^Completed with @<the project you pick>\.iam\.gserviceaccount\.com/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Choose from my projects' }).hasAttribute('disabled')).toBe(false);
  });

  it('lists, browses, verifies and writes as the default reader in the picked project', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    expect(api.gcsBucketsListedAs).toEqual([DEFAULT_READER]);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    expect(api.gcsBrowsed.map(b => b.impersonateServiceAccount)).toEqual([DEFAULT_READER, DEFAULT_READER, DEFAULT_READER]);
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });

    // Confirm names the completed address, never the bare name.
    expect(screen.getByText('Reads as')).toBeDefined();
    expect(screen.getByText(DEFAULT_READER)).toBeDefined();
    await waitFor(() => { expect(screen.getByText(`gcloud can read this export as ${DEFAULT_READER}`)).toBeDefined(); });
    expect(api.gcsDownloadChecks).toEqual([{ bucketPath: DAILY_EXPORT, impersonateServiceAccount: DEFAULT_READER }]);

    await userClickText(user, 'Complete Setup');
    await waitFor(() => { expect(api.writtenConfigs).toHaveLength(1); });
    expect(api.writtenConfigs[0]?.impersonateServiceAccount).toBe(DEFAULT_READER);
  });

  it('completes a bare name with a project typed on the intro step', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    await user.type(screen.getByLabelText('Read-only service account'), 'billing-reader');
    await user.type(screen.getByLabelText('Google Cloud project'), 'billing-504501{Enter}');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcsBucketsListedAs).toEqual(['billing-reader@billing-504501.iam.gserviceaccount.com']);
  });

  it('refuses a value that is neither an account name nor an address', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    await user.type(screen.getByLabelText('Read-only service account'), 'Costgoblin Reader');
    expect(screen.getByText(/^Use an account name like costgoblin-reader/)).toBeDefined();
    const find = screen.getByRole('button', { name: 'Choose from my projects' });
    expect(find.hasAttribute('disabled')).toBe(true);
    await user.click(find);
    expect(api.gcsBucketsListedFor).toEqual([]);
  });

  it('keeps an existing provider without a reader reading as the user', async () => {
    // Re-running setup must not quietly switch who an existing provider
    // downloads as; only a new provider starts on the default.
    const { user } = renderWizard({ config: MOCK_MIXED_PROVIDER_CONFIG });
    await act(async () => { await Promise.resolve(); });
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    expect(screen.getByLabelText('Read-only service account')).toHaveProperty('value', '');
    // Not the default, so the field is open from the start.
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(screen.getByText('your own Google account')).toBeDefined();
  });

  it('starts a new provider in add mode on the default even when others exist', async () => {
    const { user } = renderWizard({ mode: 'add', config: MOCK_MIXED_PROVIDER_CONFIG });
    await act(async () => { await Promise.resolve(); });
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    expect(screen.getByLabelText('Read-only service account')).toBe(screen.getByDisplayValue('costgoblin-reader'));
  });
});

/** The disclosure region holding the reader field. */
function readerRegion(): Element | null {
  return screen.getByLabelText('Read-only service account').closest('#gcp-reader-field');
}

describe('SetupWizard — GCP intro: project first', () => {
  it('asks for the project before the reader, and only continues on a valid project ID', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    const project = screen.getByLabelText('Google Cloud project');
    const reader = screen.getByLabelText('Read-only service account');
    expect(project.compareDocumentPosition(reader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next.hasAttribute('disabled')).toBe(true);
    await user.type(project, 'acme');
    expect(next.hasAttribute('disabled')).toBe(true);
    await user.type(project, '-prod');
    expect(next.hasAttribute('disabled')).toBe(false);

    await user.click(next);
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcsBucketsListedFor).toEqual(['acme-prod']);
    expect(api.gcsBucketsListedAs).toEqual([DEFAULT_READER]);
  });

  it('names the project rule once the field is left with a malformed ID', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    const project = screen.getByLabelText('Google Cloud project');
    await user.type(project, 'Acme Prod');
    expect(screen.queryByText(PROJECT_ID_RULES)).toBeNull();
    await user.tab();
    expect(screen.getByText(PROJECT_ID_RULES)).toBeDefined();
    expect(project.getAttribute('aria-invalid')).toBe('true');
    expect(project.getAttribute('aria-describedby')).toBe('gcp-project-id-error');
  });

  it('keeps the default reader folded into one line, resolved live against the typed project', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    const change = screen.getByRole('button', { name: 'Change' });
    expect(change.getAttribute('aria-expanded')).toBe('false');
    expect(change.getAttribute('aria-controls')).toBe('gcp-reader-field');
    expect(readerRegion()?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByText('costgoblin-reader in the project you pick')).toBeDefined();

    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod');
    expect(screen.getByText(DEFAULT_READER)).toBeDefined();
    // Still folded — typing a project is not a reason to open it.
    expect(readerRegion()?.hasAttribute('hidden')).toBe(true);
  });

  it('opens the reader field on Change, moves focus into it, and keeps it open', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    const field = screen.getByLabelText('Read-only service account');
    expect(readerRegion()?.hasAttribute('hidden')).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();

    // Typing the default back must not fold the field out from under the cursor.
    await user.clear(field);
    await user.type(field, 'costgoblin-reader');
    expect(readerRegion()?.hasAttribute('hidden')).toBe(false);
    expect(document.activeElement).toBe(field);

    await user.clear(field);
    await user.type(field, 'reader@other-proj.iam.gserviceaccount.com');
    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod');
    // A full address is used as typed, whatever the project.
    expect(screen.getByText('reader@other-proj.iam.gserviceaccount.com')).toBeDefined();
  });

  it('starts with the reader field open for a reconfigured provider s own reader', async () => {
    const reader = 'old-reader@acme-prod.iam.gserviceaccount.com';
    const gcpMain = MOCK_GCP_PROVIDER;
    if (gcpMain.type !== 'gcp') throw new Error('MOCK_GCP_PROVIDER must be a gcp provider');
    const spy = vi.spyOn(MockCostApi.prototype, 'getConfig').mockResolvedValue({
      ...MOCK_MIXED_PROVIDER_CONFIG,
      providers: [{ ...gcpMain, impersonateServiceAccount: reader }],
    });
    try {
      const { user } = renderWizard();
      await act(async () => { await Promise.resolve(); });
      await user.click(screen.getByLabelText('Set up from Google Cloud'));
      await waitFor(() => { expect(screen.getByDisplayValue(reader)).toBe(screen.getByLabelText('Read-only service account')); });
      expect(readerRegion()?.hasAttribute('hidden')).toBe(false);
      expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('reads as the user s own account once the reader is cleared', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    expect(screen.getByText('your own Google account')).toBeDefined();
    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod{Enter}');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcsBucketsListedAs).toEqual([undefined]);
  });

  it('opens the project list from "Choose from my projects"', async () => {
    const { api, user } = renderWizard();
    const listSpy = vi.spyOn(api, 'listGcpProjects');
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    expect(listSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Choose from my projects' }));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    expect(listSpy).toHaveBeenCalledOnce();
  });
});

describe('SetupWizard — GCP download check on Confirm', () => {
  it('checks every collected tier as the reader before enabling Complete Setup', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    await enterGcpBrowse(user);
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder daily'));
    await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
    await userClickText(user, 'Add hourly export');
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    await userClickText(user, 'acme-focus-export');
    await waitFor(() => { expect(screen.getByLabelText('Open folder focus')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder focus'));
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder hourly'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText(`gcloud can read this export as ${DEFAULT_READER}`)).toBeDefined(); });
    expect(api.gcsDownloadChecks.slice(-2)).toEqual([
      { bucketPath: DAILY_EXPORT, impersonateServiceAccount: DEFAULT_READER },
      { bucketPath: HOURLY_EXPORT, impersonateServiceAccount: DEFAULT_READER },
    ]);
    expect(completeSetupButton().hasAttribute('disabled')).toBe(false);
  });

  it('holds Complete Setup while the check runs', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    let settle: ((r: { ok: true }) => void) | undefined;
    api.verifyGcsDownload = () => new Promise((r) => { settle = r; });
    await enterGcpBrowse(user);
    await walkGcpFromBucketRootToConfirm(user);
    expect(screen.getByText(/^Checking that gcloud can read this export as/)).toBeDefined();
    expect(completeSetupButton().hasAttribute('disabled')).toBe(true);
    await act(async () => { settle?.({ ok: true }); await Promise.resolve(); });
    await waitFor(() => { expect(completeSetupButton().hasAttribute('disabled')).toBe(false); });
  });

  it('blocks the save on a refusal, shows gcloud s error, and re-checks on Retry', async () => {
    const denied = 'ERROR: (gcloud.storage.ls) HTTPError 403: alice@acme.com does not have storage.objects.list access to the Google Cloud Storage bucket.';
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsDownloadCheckResult = { ok: false, error: denied };
    await enterGcpBrowse(user);
    await walkGcpFromBucketRootToConfirm(user);
    await waitFor(() => { expect(screen.getByText(denied)).toBeDefined(); });
    expect(screen.getByText(`gcloud could not read the daily export as ${DEFAULT_READER}, so syncing it would fail.`)).toBeDefined();
    expect(completeSetupButton().hasAttribute('disabled')).toBe(true);
    // Not a credential error: a plain Retry, no sign-in.
    expect(screen.queryByText('Sign in the gcloud CLI')).toBeNull();

    api.gcsDownloadCheckResult = { ok: true };
    await userClickText(user, 'Retry');
    await waitFor(() => { expect(screen.getByText(`gcloud can read this export as ${DEFAULT_READER}`)).toBeDefined(); });
    expect(api.gcsDownloadChecks).toHaveLength(2);
    expect(completeSetupButton().hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('Save anyway')).toBeNull();
  });

  it('offers the gcloud CLI sign-in when the download identity is signed out', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsDownloadCheckResult = { ok: false, error: 'ERROR: (gcloud.storage.ls) You do not currently have an active account selected. Please run:\n\n  $ gcloud auth login' };
    await enterGcpBrowse(user);
    await walkGcpFromBucketRootToConfirm(user);
    await waitFor(() => { expect(screen.getByText('Sign in the gcloud CLI')).toBeDefined(); });
  });

  it('explains a missing gcloud CLI rather than showing the sentinel', async () => {
    const { api, user } = renderWizard();
    gcpExportLayout(api);
    api.gcsDownloadCheckResult = { ok: false, error: 'GCLOUD_CLI_NOT_FOUND' };
    await enterGcpBrowse(user);
    await walkGcpFromBucketRootToConfirm(user);
    await waitFor(() => { expect(screen.getByText('Install the gcloud CLI')).toBeDefined(); });
    expect(screen.queryByText('GCLOUD_CLI_NOT_FOUND')).toBeNull();
  });

  it('saves anyway on an explicit request after a refusal', async () => {
    const { api, user, onComplete } = renderWizard();
    gcpExportLayout(api);
    api.gcsDownloadCheckResult = { ok: false, error: 'Network is unreachable' };
    await enterGcpBrowse(user);
    await walkGcpFromBucketRootToConfirm(user);
    await waitFor(() => { expect(screen.getByText('Save anyway')).toBeDefined(); });
    await userClickText(user, 'Save anyway');
    await waitFor(() => { expect(onComplete).toHaveBeenCalledOnce(); });
    expect(api.writtenConfigs[0]?.dailyBucket).toBe(DAILY_EXPORT);
    expect(api.writtenConfigs[0]?.impersonateServiceAccount).toBe(DEFAULT_READER);
  });

  it('names the tier that failed', async () => {
    const { api, user } = renderWizard({ ...configureHourlyOnGcpMain(), prepare: gcpExportLayout });
    api.gcsDownloadCheckByPath = { [HOURLY_EXPORT]: { ok: false, error: 'denied' } };
    await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
    await user.click(screen.getByLabelText('Open folder hourly'));
    await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
    await userClickText(user, 'Use this location');
    await waitFor(() => { expect(screen.getByText('gcloud could not read the hourly export as your gcloud account, so syncing it would fail.')).toBeDefined(); });
    // Per-tier Configure checks only the tier it came for.
    expect(api.gcsDownloadChecks).toEqual([{ bucketPath: HOURLY_EXPORT }]);
  });

  it('checks a carried reader, and a key-file provider by name', async () => {
    const gcpMain = MOCK_GCP_PROVIDER;
    if (gcpMain.type !== 'gcp') throw new Error('MOCK_GCP_PROVIDER must be a gcp provider');
    const carried = 'kept-reader@acme-prod.iam.gserviceaccount.com';
    // A reader on the provider, none passed by per-tier Configure: the upsert
    // carries it, so that is who the download — and the check — runs as.
    const withReader = renderWizard({ ...configureHourlyOnGcpMain({ ...gcpMain, impersonateServiceAccount: carried }), prepare: gcpExportLayout });
    await reachHourlyConfirm(withReader.user);
    await waitFor(() => { expect(screen.getByText(`gcloud can read this export as ${carried}`)).toBeDefined(); });
    expect(withReader.api.gcsDownloadChecks).toEqual([{ bucketPath: HOURLY_EXPORT, impersonateServiceAccount: carried }]);
    cleanup();

    const withKey = renderWizard({ ...configureHourlyOnGcpMain({ ...gcpMain, keyFile: '/keys/reader.json' }), prepare: gcpExportLayout });
    await reachHourlyConfirm(withKey.user);
    await waitFor(() => { expect(screen.getByText('gcloud can read this export as the provider’s service account key')).toBeDefined(); });
    expect(withKey.api.gcsDownloadChecks).toEqual([{ bucketPath: HOURLY_EXPORT, keyFileProvider: 'gcp-main' }]);
  });

  it('does not run for an AWS provider', async () => {
    const { api, user } = renderWizard();
    await user.click(screen.getByLabelText('Set up from AWS'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await userClickText(user, 'default');
    await walkToConfirm(user);
    expect(screen.queryByText('Download check')).toBeNull();
    expect(api.gcsDownloadChecks).toEqual([]);
    expect(completeSetupButton().hasAttribute('disabled')).toBe(false);
  });
});

/** Bucket root → focus/daily → Use this location → Confirm. */
async function walkGcpFromBucketRootToConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByLabelText('Open folder focus'));
  await waitFor(() => { expect(screen.getByLabelText('Open folder daily')).toBeDefined(); });
  await user.click(screen.getByLabelText('Open folder daily'));
  await waitFor(() => { expect(screen.getByText('Use this location')).toBeDefined(); });
  await userClickText(user, 'Use this location');
  await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
}

/** Per-tier Configure of gcp-main's hourly tier, the provider as given. */
function configureHourlyOnGcpMain(provider: CostGoblinConfig['providers'][number] = MOCK_GCP_PROVIDER) {
  return {
    source: 'hourly' as const,
    providerName: 'gcp-main',
    gcpSource: { bucket: 'acme-focus-export', prefix: 'focus/' },
    config: {
      providers: [{ ...provider, sync: { daily: { bucket: asBucketPath(DAILY_EXPORT), retentionDays: 365 }, intervalMinutes: 60 } }],
      defaults: { periodDays: 30, costMetric: 'effective' as const, lagDays: 2 },
    },
  };
}

async function reachHourlyConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => { expect(screen.getByLabelText('Open folder hourly')).toBeDefined(); });
  await user.click(screen.getByLabelText('Open folder hourly'));
  await waitFor(() => { expect(screen.getByText('FOCUS export detected')).toBeDefined(); });
  await userClickText(user, 'Use this location');
  await waitFor(() => { expect(screen.getByText('Confirm Setup')).toBeDefined(); });
}

/** What `setup:list-gcs-buckets` answers when the reader can't be minted:
 *  `describeGcpImpersonationFailure` around google-auth-library's wrapper. */
const READER_REFUSED =
  'CostGoblin could not read as costgoblin-reader@acme-prod.iam.gserviceaccount.com. Check that the service account exists, '
  + 'that your Google account has roles/iam.serviceAccountTokenCreator on it — Details: Could not refresh access token: '
  + 'unable to impersonate: Failed to impersonate: PERMISSION_DENIED';

describe('SetupWizard — GCP reader check on Continue', () => {
  it('stays on the intro with one line when the reader cannot be read as', async () => {
    const { api, user } = renderWizard();
    api.gcsBucketsResult = { buckets: [], error: READER_REFUSED };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod{Enter}');

    await waitFor(() => { expect(screen.getByRole('alert')).toBeDefined(); });
    expect(screen.getByRole('alert').textContent).toMatch(
      /^Can't read as costgoblin-reader — it doesn't exist in acme-prod, or your Google account lacks the Token Creator role on it\./,
    );
    // Still the intro, checked as the completed default.
    expect(screen.getByLabelText('Google Cloud project')).toBeDefined();
    expect(api.gcsBucketsListedAs).toEqual([DEFAULT_READER]);
    // The full remedy stays one click away, not on the page.
    expect(screen.getByText(READER_REFUSED).closest('details')?.open).toBe(false);
  });

  it('drops the verdict once the reader is edited, and re-checks on Continue', async () => {
    const { api, user } = renderWizard();
    api.gcsBucketsResult = { buckets: [], error: READER_REFUSED };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod{Enter}');
    await waitFor(() => { expect(screen.getByRole('alert')).toBeDefined(); });

    await openReaderField(user);
    await user.clear(screen.getByLabelText('Read-only service account'));
    await user.type(screen.getByLabelText('Read-only service account'), 'other-reader');
    expect(screen.queryByRole('alert')).toBeNull();

    api.gcsBucketsResult = { buckets: [{ name: 'acme-focus-export' }] };
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
    expect(api.gcsBucketsListedAs).toEqual([DEFAULT_READER, 'other-reader@acme-prod.iam.gserviceaccount.com']);
  });

  it('says it is checking while the listing runs', async () => {
    const { api, user } = renderWizard();
    let resolveBuckets: ((r: { buckets: readonly { name: string }[] }) => void) | undefined;
    api.listGcsBuckets = () => new Promise((r) => { resolveBuckets = r; });
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.type(screen.getByLabelText('Google Cloud project'), 'acme-prod{Enter}');

    const checking = screen.getByRole('button', { name: 'Checking access…' });
    expect(checking.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      resolveBuckets?.({ buckets: [{ name: 'acme-focus-export' }] });
      await Promise.resolve();
    });
    await waitFor(() => { expect(screen.getByText('acme-focus-export')).toBeDefined(); });
  });

  it('shows the same line on the bucket step when the project was picked from the list', async () => {
    const { api, user } = renderWizard();
    api.gcsBucketsResult = { buckets: [], error: READER_REFUSED };
    await user.click(screen.getByLabelText('Set up from Google Cloud'));
    await user.click(screen.getByText('Choose from my projects'));
    await waitFor(() => { expect(screen.getByText('Acme Production')).toBeDefined(); });
    await userClickText(user, 'Acme Production');

    await waitFor(() => { expect(screen.getByText(/^Can't read as/)).toBeDefined(); });
    expect(screen.getByText(/^Can't read as/).textContent).toMatch(/costgoblin-reader — it doesn't exist in acme-prod/);
    // Not offered as a sign-in: no login fixes a missing grant.
    expect(screen.queryByText(/Sign in/)).toBeNull();
  });
});
