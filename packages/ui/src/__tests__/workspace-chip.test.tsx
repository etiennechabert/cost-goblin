import type { WorkspacesInfo } from '@costgoblin/core/browser';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceChip } from '../components/workspace-chip.js';

const ONE_WORKSPACE: WorkspacesInfo = {
  mode: 'workspace',
  active: 'default',
  workspaces: [
    { name: 'default', active: true, configured: true, sizeBytes: null, lastUsedAt: null },
  ],
};

const TWO_WORKSPACES: WorkspacesInfo = {
  mode: 'workspace',
  active: 'default',
  workspaces: [
    { name: 'default', active: true, configured: true, sizeBytes: null, lastUsedAt: null },
    { name: 'client-acme', active: false, configured: true, sizeBytes: null, lastUsedAt: null },
  ],
};

describe('WorkspaceChip', () => {
  it('renders nothing with a single workspace', () => {
    const { container } = render(
      <WorkspaceChip info={ONE_WORKSPACE} onSwitch={vi.fn()} onManage={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing in pinned mode', () => {
    const { container } = render(
      <WorkspaceChip
        info={{ mode: 'pinned', active: null, workspaces: TWO_WORKSPACES.workspaces }}
        onSwitch={vi.fn()}
        onManage={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the active workspace name with two workspaces', () => {
    render(<WorkspaceChip info={TWO_WORKSPACES} onSwitch={vi.fn()} onManage={vi.fn()} />);
    const chip = screen.getByTestId('workspace-chip');
    expect(chip.textContent).toContain('default');
    // The chip sits in the draggable title bar — it must opt out of dragging.
    expect(chip.className).toContain('[-webkit-app-region:no-drag]');
  });

  it('opens a menu listing every workspace plus Manage workspaces', async () => {
    const user = userEvent.setup();
    render(<WorkspaceChip info={TWO_WORKSPACES} onSwitch={vi.fn()} onManage={vi.fn()} />);

    await user.click(screen.getByTestId('workspace-chip'));

    const menu = screen.getByRole('group', { name: 'Workspaces' });
    const defaultItem = screen.getByRole('button', { name: 'default' });
    expect(menu.contains(defaultItem)).toBe(true);
    // The active entry is disabled.
    expect(defaultItem.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'client-acme' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Manage workspaces…' })).toBeDefined();
  });

  it('fires onSwitch with the name when an inactive workspace is clicked', async () => {
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(<WorkspaceChip info={TWO_WORKSPACES} onSwitch={onSwitch} onManage={vi.fn()} />);

    await user.click(screen.getByTestId('workspace-chip'));
    await user.click(screen.getByRole('button', { name: 'client-acme' }));

    expect(onSwitch).toHaveBeenCalledOnce();
    expect(onSwitch).toHaveBeenCalledWith('client-acme');
  });

  it('fires onManage from the Manage workspaces item', async () => {
    const onManage = vi.fn();
    const user = userEvent.setup();
    render(<WorkspaceChip info={TWO_WORKSPACES} onSwitch={vi.fn()} onManage={onManage} />);

    await user.click(screen.getByTestId('workspace-chip'));
    await user.click(screen.getByRole('button', { name: 'Manage workspaces…' }));

    expect(onManage).toHaveBeenCalledOnce();
  });
});
