import type { WorkspacesInfo } from '@costgoblin/core/browser';
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { WorkspacesView } from '../views/workspaces.js';

const TWO_WORKSPACES: WorkspacesInfo = {
  mode: 'workspace',
  active: 'default',
  workspaces: [
    { name: 'default', active: true, configured: true, sizeBytes: 128 * 1024 * 1024, lastUsedAt: '2026-06-11T09:00:00.000Z' },
    { name: 'client-acme', active: false, configured: false, sizeBytes: null, lastUsedAt: null },
  ],
};

const PINNED: WorkspacesInfo = { mode: 'pinned', active: null, workspaces: [] };

function apiWith(info: WorkspacesInfo): MockCostApi {
  const api = new MockCostApi();
  api.getWorkspaces = () => Promise.resolve(info);
  return api;
}

function renderView(api: MockCostApi) {
  return render(
    <CostApiProvider value={api}>
      <WorkspacesView />
    </CostApiProvider>,
  );
}

describe('WorkspacesView', () => {
  it('renders the workspace list with active badge, size, last-used, and not-set-up hint', async () => {
    renderView(apiWith(TWO_WORKSPACES));

    const defaultRow = await screen.findByTestId('workspace-row-default');
    expect(within(defaultRow).getByText('default')).toBeDefined();
    expect(within(defaultRow).getByText('Active')).toBeDefined();
    expect(within(defaultRow).getByText('128 MB · Last used Jun 11, 2026')).toBeDefined();

    const acmeRow = screen.getByTestId('workspace-row-client-acme');
    expect(within(acmeRow).getByText('client-acme')).toBeDefined();
    expect(within(acmeRow).getByText('Not set up')).toBeDefined();
    // Null size and last-used render em-dashes.
    expect(within(acmeRow).getByText('— · Last used —')).toBeDefined();
    expect(within(acmeRow).queryByText('Active')).toBeNull();
  });

  it('hides Switch and Delete on the active workspace', async () => {
    renderView(apiWith(TWO_WORKSPACES));

    const defaultRow = await screen.findByTestId('workspace-row-default');
    expect(within(defaultRow).queryByRole('button', { name: 'Switch' })).toBeNull();
    expect(within(defaultRow).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(defaultRow).getByRole('button', { name: 'Rename' })).toBeDefined();

    const acmeRow = screen.getByTestId('workspace-row-client-acme');
    expect(within(acmeRow).getByRole('button', { name: 'Switch' })).toBeDefined();
    expect(within(acmeRow).getByRole('button', { name: 'Delete' })).toBeDefined();
  });

  it('pinned mode shows the info card and no New workspace button', async () => {
    renderView(apiWith(PINNED));

    expect(await screen.findByText('Workspaces are unavailable in this session')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'New workspace' })).toBeNull();
    expect(screen.queryByTestId('workspace-row-default')).toBeNull();
  });

  it('rejects an invalid name in the New workspace modal and disables Create & Restart', async () => {
    const user = userEvent.setup();
    renderView(apiWith(TWO_WORKSPACES));

    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    await user.type(screen.getByLabelText('Workspace name'), 'bad name');

    expect(screen.getByText(/letters, digits/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create & Restart' }).hasAttribute('disabled')).toBe(true);
  });

  it('rejects a duplicate name case-insensitively', async () => {
    const user = userEvent.setup();
    renderView(apiWith(TWO_WORKSPACES));

    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    await user.type(screen.getByLabelText('Workspace name'), 'Default');

    expect(screen.getByText('A workspace named "Default" already exists.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create & Restart' }).hasAttribute('disabled')).toBe(true);
  });

  it('lists the existing workspaces in the New workspace modal', async () => {
    const user = userEvent.setup();
    renderView(apiWith(TWO_WORKSPACES));

    await user.click(await screen.findByRole('button', { name: 'New workspace' }));

    expect(screen.getByText(/Existing:/)).toBeDefined();
    expect(screen.getByText(/default, client-acme/)).toBeDefined();
  });

  it('creates a fresh workspace and restarts into it', async () => {
    const api = apiWith(TWO_WORKSPACES);
    const createSpy = vi.spyOn(api, 'createWorkspace');
    const user = userEvent.setup();
    renderView(api);

    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    await user.type(screen.getByLabelText('Workspace name'), 'client-two');
    await user.click(screen.getByRole('button', { name: 'Create & Restart' }));

    // Creation always switches into the new workspace (the boot wizard takes
    // over from there).
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith('client-two', { kind: 'fresh' }, true);
    });
  });

  it('surfaces a create error inside the modal', async () => {
    const api = apiWith(TWO_WORKSPACES);
    api.createWorkspace = () => Promise.reject(new Error('disk full'));
    const user = userEvent.setup();
    renderView(api);

    await user.click(await screen.findByRole('button', { name: 'New workspace' }));
    await user.type(screen.getByLabelText('Workspace name'), 'client-two');
    await user.click(screen.getByRole('button', { name: 'Create & Restart' }));

    expect(await screen.findByText('disk full')).toBeDefined();
    // The modal stays open for another attempt.
    expect(screen.getByLabelText('Workspace name')).toBeDefined();
  });

  it('deletes a workspace after the destructive confirm', async () => {
    const api = apiWith(TWO_WORKSPACES);
    const deleteSpy = vi.spyOn(api, 'deleteWorkspace');
    const user = userEvent.setup();
    renderView(api);

    const acmeRow = await screen.findByTestId('workspace-row-client-acme');
    await user.click(within(acmeRow).getByRole('button', { name: 'Delete' }));

    expect(screen.getByText(/permanently deletes all of its synced data and configuration/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Delete Workspace' }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('client-acme');
    });
  });

  it('switches after confirming the restart', async () => {
    const api = apiWith(TWO_WORKSPACES);
    const switchSpy = vi.spyOn(api, 'switchWorkspace');
    const user = userEvent.setup();
    renderView(api);

    const acmeRow = await screen.findByTestId('workspace-row-client-acme');
    await user.click(within(acmeRow).getByRole('button', { name: 'Switch' }));

    expect(screen.getByText('Switch to workspace "client-acme"? CostGoblin will restart.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Switch & Restart' }));

    await waitFor(() => {
      expect(switchSpy).toHaveBeenCalledWith('client-acme');
    });
  });

  it('renames an inactive workspace via the rename modal', async () => {
    const api = apiWith(TWO_WORKSPACES);
    const renameSpy = vi.spyOn(api, 'renameWorkspace');
    const user = userEvent.setup();
    renderView(api);

    const acmeRow = await screen.findByTestId('workspace-row-client-acme');
    await user.click(within(acmeRow).getByRole('button', { name: 'Rename' }));

    const modal = screen.getByRole('dialog');
    const input = within(modal).getByLabelText('New name');
    await user.clear(input);
    await user.type(input, 'client-beta');
    await user.click(within(modal).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith('client-acme', 'client-beta');
    });
  });
});
