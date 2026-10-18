import type { WorkspacesInfo } from '@costgoblin/core/browser';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { WorkspacesView } from '../views/workspaces.js';
import { deferred } from './deferred.js';

const THREE: WorkspacesInfo = {
  mode: 'workspace',
  active: 'default',
  workspaces: [
    { name: 'default', active: true, configured: true, sizeBytes: 1024, lastUsedAt: '2026-06-11T09:00:00.000Z' },
    { name: 'client-acme', active: false, configured: true, sizeBytes: 5 * 1024 * 1024, lastUsedAt: 'not a date' },
    { name: 'client-beta', active: false, configured: true, sizeBytes: null, lastUsedAt: null },
  ],
};

function apiWith(info: WorkspacesInfo = THREE): MockCostApi {
  const api = new MockCostApi();
  vi.spyOn(api, 'getWorkspaces').mockResolvedValue(info);
  return api;
}

function renderView(api: MockCostApi, onChanged?: (info: WorkspacesInfo) => void) {
  const user = userEvent.setup();
  const view = render(
    <CostApiProvider value={api}>
      <WorkspacesView onChanged={onChanged} />
    </CostApiProvider>,
  );
  return { user, ...view };
}

async function row(name: string): Promise<HTMLElement> {
  return screen.findByTestId(`workspace-row-${name}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('WorkspacesView — loading', () => {
  it.each([
    { reason: new Error('workspaces.json is corrupt'), text: 'Could not load workspaces: workspaces.json is corrupt' },
    { reason: 'EACCES', text: 'Could not load workspaces: EACCES' },
  ])('says why the list could not be loaded ($text)', async ({ reason, text }) => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getWorkspaces').mockRejectedValue(reason);
    renderView(api);
    expect(screen.getByText('Loading workspaces…')).toBeDefined();
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'New workspace' })).toBeNull();
  });

  it('reports the loaded list to the host, but not one that lands after it closed', async () => {
    const onChanged = vi.fn<(info: WorkspacesInfo) => void>();
    renderView(apiWith(), onChanged);
    await waitFor(() => { expect(onChanged).toHaveBeenCalledWith(THREE); });
    cleanup();

    const late = new MockCostApi();
    const pending = deferred<WorkspacesInfo>();
    vi.spyOn(late, 'getWorkspaces').mockReturnValue(pending.promise);
    const onLate = vi.fn<(info: WorkspacesInfo) => void>();
    const { unmount } = renderView(late, onLate);
    unmount();
    pending.resolve(THREE);
    await pending.promise;
    expect(onLate).not.toHaveBeenCalled();
  });

  it('shows a dash for a last-used time it cannot read', async () => {
    renderView(apiWith());
    expect(within(await row('client-acme')).getByText('5.0 MB · Last used —')).toBeDefined();
  });
});

describe('WorkspacesView — names', () => {
  it('refuses a reserved device name with its own message', async () => {
    const { user } = renderView(apiWith());
    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    await user.type(screen.getByLabelText('Workspace name'), 'con');
    expect(screen.getByText('"con" is a reserved name — please pick a different one.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create & Restart' })).toHaveProperty('disabled', true);
  });

  it('reports a create failure that is not an Error', async () => {
    const api = apiWith();
    vi.spyOn(api, 'createWorkspace').mockRejectedValue('quota exceeded');
    const { user } = renderView(api);
    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    await user.type(screen.getByLabelText('Workspace name'), 'client-gamma');
    await user.click(screen.getByRole('button', { name: 'Create & Restart' }));
    expect(await screen.findByText('quota exceeded')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create & Restart' })).toHaveProperty('disabled', false);
  });

  it('shows Creating… while the workspace is being created', async () => {
    const api = apiWith();
    vi.spyOn(api, 'createWorkspace').mockReturnValue(new Promise<WorkspacesInfo>(() => undefined));
    const { user } = renderView(api);
    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    await user.type(screen.getByLabelText('Workspace name'), 'client-gamma');
    await user.click(screen.getByRole('button', { name: 'Create & Restart' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toHaveProperty('disabled', true);
  });
});

describe('WorkspacesView — rename', () => {
  async function openRename(user: ReturnType<typeof userEvent.setup>, name: string): Promise<HTMLElement> {
    await user.click(within(await row(name)).getByRole('button', { name: 'Rename' }));
    return screen.getByRole('dialog', { name: 'Rename workspace' });
  }

  it('holds Rename until the name changes, and refuses taken or reserved names', async () => {
    const { user } = renderView(apiWith());
    const modal = await openRename(user, 'client-acme');
    const input = within(modal).getByLabelText('New name');
    const rename = within(modal).getByRole('button', { name: 'Rename' });
    // Unchanged: nothing to do, and no complaint about the name it already has.
    expect(rename).toHaveProperty('disabled', true);
    expect(within(modal).queryByText(/already exists/)).toBeNull();

    await user.clear(input);
    await user.type(input, 'CLIENT-BETA');
    expect(within(modal).getByText('A workspace named "CLIENT-BETA" already exists.')).toBeDefined();
    expect(rename).toHaveProperty('disabled', true);

    await user.clear(input);
    await user.type(input, 'lpt1');
    expect(within(modal).getByText('"lpt1" is a reserved name — please pick a different one.')).toBeDefined();

    await user.clear(input);
    expect(rename).toHaveProperty('disabled', true);
  });

  it('warns that renaming the active workspace restarts the app', async () => {
    const { user } = renderView(apiWith());
    const modal = await openRename(user, 'default');
    expect(within(modal).getByText(/This is the active workspace/)).toBeDefined();
    await user.click(within(modal).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Rename workspace' })).toBeNull();
  });

  it('applies an inactive rename to the list and tells the host', async () => {
    const api = apiWith();
    const renamed: WorkspacesInfo = { ...THREE, workspaces: THREE.workspaces.map(w => w.name === 'client-beta' ? { ...w, name: 'client-gamma' } : w) };
    vi.spyOn(api, 'renameWorkspace').mockResolvedValue(renamed);
    const onChanged = vi.fn<(info: WorkspacesInfo) => void>();
    const { user } = renderView(api, onChanged);
    const modal = await openRename(user, 'client-beta');
    const input = within(modal).getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'client-gamma');
    await user.click(within(modal).getByRole('button', { name: 'Rename' }));

    expect(await row('client-gamma')).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'Rename workspace' })).toBeNull();
    expect(onChanged).toHaveBeenLastCalledWith(renamed);
  });

  it.each([
    { reason: new Error('target directory exists'), text: 'target directory exists' },
    { reason: 'EBUSY', text: 'EBUSY' },
  ])('keeps the modal open with the error when renaming fails ($text)', async ({ reason, text }) => {
    const api = apiWith();
    vi.spyOn(api, 'renameWorkspace').mockRejectedValue(reason);
    const { user } = renderView(api);
    const modal = await openRename(user, 'client-beta');
    const input = within(modal).getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'client-delta');
    await user.click(within(modal).getByRole('button', { name: 'Rename' }));

    expect(await within(modal).findByText(text)).toBeDefined();
    expect(within(modal).getByRole('button', { name: 'Rename' })).toHaveProperty('disabled', false);
  });

  it('shows Renaming… while the rename runs', async () => {
    const api = apiWith();
    vi.spyOn(api, 'renameWorkspace').mockReturnValue(new Promise<WorkspacesInfo>(() => undefined));
    const { user } = renderView(api);
    const modal = await openRename(user, 'client-beta');
    const input = within(modal).getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'client-delta');
    await user.click(within(modal).getByRole('button', { name: 'Rename' }));
    expect(within(modal).getByRole('button', { name: 'Renaming…' })).toHaveProperty('disabled', true);
  });
});

describe('WorkspacesView — switch and delete', () => {
  it.each([
    { reason: new Error('workspace is locked by another window'), text: 'workspace is locked by another window' },
    { reason: 'ELOCKED', text: 'ELOCKED' },
  ])('closes the switch confirm and shows why switching failed ($text)', async ({ reason, text }) => {
    const api = apiWith();
    vi.spyOn(api, 'switchWorkspace').mockRejectedValue(reason);
    const { user } = renderView(api);
    await user.click(within(await row('client-acme')).getByRole('button', { name: 'Switch' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Switch workspace' })).getByRole('button', { name: 'Switch & Restart' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'Switch workspace' })).toBeNull();
  });

  it('can back out of switching', async () => {
    const api = apiWith();
    const switchSpy = vi.spyOn(api, 'switchWorkspace');
    const { user } = renderView(api);
    await user.click(within(await row('client-acme')).getByRole('button', { name: 'Switch' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Switch workspace' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Switch workspace' })).toBeNull();
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it('says how much data a delete removes, and can be backed out of', async () => {
    const api = apiWith();
    const deleteSpy = vi.spyOn(api, 'deleteWorkspace');
    const { user } = renderView(api);
    await user.click(within(await row('client-acme')).getByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete workspace' });
    expect(within(confirm).getByText(/\(5\.0 MB on disk\)/)).toBeDefined();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it.each([
    { reason: new Error('files in use'), text: 'files in use' },
    { reason: 'EPERM', text: 'EPERM' },
  ])('shows why a delete failed and keeps the workspace listed ($text)', async ({ reason, text }) => {
    const api = apiWith();
    vi.spyOn(api, 'deleteWorkspace').mockRejectedValue(reason);
    const { user } = renderView(api);
    await user.click(within(await row('client-beta')).getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Delete workspace' })).getByRole('button', { name: 'Delete Workspace' }));
    expect(await screen.findByText(text)).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'Delete workspace' })).toBeNull();
    expect(await row('client-beta')).toBeDefined();
  });
});
