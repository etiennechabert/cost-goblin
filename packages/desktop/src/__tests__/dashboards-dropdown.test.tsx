import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DashboardsDropdown } from '../renderer/top-menu/dashboards-dropdown.js';
import type { DashboardItem } from '../renderer/top-menu/dashboards-dropdown.js';

const ITEMS: readonly DashboardItem[] = [
  { id: 'overview', name: 'Overview' },
  { id: 'teams', name: 'Team costs' },
  { id: 'k8s', name: 'Kubernetes' },
];

function renderDropdown(fields: Partial<Parameters<typeof DashboardsDropdown>[0]> = {}): {
  user: ReturnType<typeof userEvent.setup>;
  onSelect: ReturnType<typeof vi.fn>;
  onSetDefault: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const onSetDefault = vi.fn();
  const user = userEvent.setup();
  render(
    <DashboardsDropdown
      items={ITEMS}
      activeId={null}
      defaultId="teams"
      onSelect={onSelect}
      onSetDefault={onSetDefault}
      {...fields}
    />,
  );
  return { user, onSelect, onSetDefault };
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: 'Dashboards' });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(trigger());
  return screen.findByRole('menu');
}

describe('DashboardsDropdown', () => {
  it('shows a labelled icon while a non-dashboard page is open', () => {
    renderDropdown({ activeId: 'trends' });
    expect(trigger().textContent).toBe('');
    expect(trigger().getAttribute('title')).toBe('Dashboards');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('spells out "Dashboards" while one of them is open', () => {
    renderDropdown({ activeId: 'k8s' });
    expect(trigger().textContent).toBe('Dashboards');
    expect(trigger().getAttribute('title')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBeNull();
  });

  it('lists the default dashboard first, then the rest in order', async () => {
    const { user } = renderDropdown();
    const menu = await openMenu(user);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Team costs', 'Overview', 'Kubernetes']);
  });

  it('keeps the given order when the default is not among the dashboards', async () => {
    const { user } = renderDropdown({ defaultId: 'deleted' });
    const menu = await openMenu(user);
    expect(within(menu).getAllByRole('menuitem').map(i => i.textContent)).toEqual(['Overview', 'Team costs', 'Kubernetes']);
  });

  it('marks the open dashboard as the current page', async () => {
    const { user } = renderDropdown({ activeId: 'k8s' });
    const menu = await openMenu(user);
    expect(within(menu).getByRole('menuitem', { name: 'Kubernetes' }).getAttribute('aria-current')).toBe('page');
    expect(within(menu).getByRole('menuitem', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
  });

  it('opens a dashboard and closes the menu', async () => {
    const { user, onSelect } = renderDropdown();
    const menu = await openMenu(user);

    await user.click(within(menu).getByRole('menuitem', { name: 'Kubernetes' }));

    expect(onSelect).toHaveBeenCalledWith('k8s');
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
  });

  it('stars another dashboard as the default, but not the one already starred', async () => {
    const { user, onSetDefault } = renderDropdown();
    const menu = await openMenu(user);

    const current = within(menu).getByRole('button', { name: 'Team costs is the default dashboard' });
    expect(current).toHaveProperty('disabled', true);

    await user.click(within(menu).getByRole('button', { name: 'Set Overview as default' }));
    expect(onSetDefault).toHaveBeenCalledWith('overview');
    // Starring is not navigating: the menu stays open.
    expect(screen.getByRole('menu')).toBeDefined();
  });
});
