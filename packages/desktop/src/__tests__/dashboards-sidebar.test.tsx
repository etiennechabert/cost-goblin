import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DashboardsSidebar, resolveLastDashboard } from '../renderer/dashboards-sidebar.js';
import type { DashboardItem } from '../renderer/dashboards-sidebar.js';

const ITEMS: readonly DashboardItem[] = [
  { id: 'overview', name: 'Overview' },
  { id: 'teams', name: 'Team costs' },
  { id: 'k8s', name: 'Kubernetes' },
];

function renderSidebar(fields: Partial<Parameters<typeof DashboardsSidebar>[0]> = {}): {
  user: ReturnType<typeof userEvent.setup>;
  onSelect: ReturnType<typeof vi.fn>;
  onSetDefault: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const onSetDefault = vi.fn();
  const user = userEvent.setup();
  render(
    <DashboardsSidebar
      items={ITEMS}
      activeId="overview"
      defaultId="teams"
      onSelect={onSelect}
      onSetDefault={onSetDefault}
      topOffset={0}
      {...fields}
    />,
  );
  return { user, onSelect, onSetDefault };
}

function sidebar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Dashboards' });
}

function rowNames(): (string | null)[] {
  return within(sidebar()).getAllByRole('listitem').map(i => i.textContent);
}

describe('DashboardsSidebar', () => {
  it('lists the default dashboard first, then the rest in order', () => {
    renderSidebar();
    expect(rowNames()).toEqual(['Team costs', 'Overview', 'Kubernetes']);
  });

  it('keeps the given order when the default is not among the dashboards', () => {
    renderSidebar({ defaultId: 'deleted' });
    expect(rowNames()).toEqual(['Overview', 'Team costs', 'Kubernetes']);
  });

  it('marks the open dashboard as the current page', () => {
    renderSidebar({ activeId: 'k8s' });
    expect(within(sidebar()).getByRole('button', { name: 'Kubernetes' }).getAttribute('aria-current')).toBe('page');
    expect(within(sidebar()).getByRole('button', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
  });

  it('opens a dashboard', async () => {
    const { user, onSelect } = renderSidebar();
    await user.click(within(sidebar()).getByRole('button', { name: 'Kubernetes' }));
    expect(onSelect).toHaveBeenCalledWith('k8s');
  });

  it('stars another dashboard as the default, but not the one already starred', async () => {
    const { user, onSelect, onSetDefault } = renderSidebar();
    const current = within(sidebar()).getByRole('button', { name: 'Team costs is the default dashboard' });
    expect(current).toHaveProperty('disabled', true);

    await user.click(within(sidebar()).getByRole('button', { name: 'Set Overview as default' }));
    expect(onSetDefault).toHaveBeenCalledWith('overview');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows a long name in full on hover', () => {
    const name = 'Platform engineering shared services and their Kubernetes costs';
    renderSidebar({ items: [...ITEMS, { id: 'long', name }] });
    const row = within(sidebar()).getByRole('button', { name });
    expect(row.getAttribute('title')).toBe(name);
    expect(row.className).toContain('truncate');
  });

  it('sticks below the header and scrolls on its own', () => {
    renderSidebar({ topOffset: 80 });
    expect(sidebar().style.top).toBe('80px');
    expect(sidebar().style.maxHeight).toBe('calc(100vh - 80px)');
    expect(sidebar().className).toContain('overflow-y-auto');
  });
});

describe('resolveLastDashboard', () => {
  it('reopens the last dashboard while it exists', () => {
    expect(resolveLastDashboard('k8s', ITEMS, 'teams')).toBe('k8s');
  });

  it('falls back to the default when the last one is gone or none was opened', () => {
    expect(resolveLastDashboard('deleted', ITEMS, 'teams')).toBe('teams');
    expect(resolveLastDashboard(null, ITEMS, 'teams')).toBe('teams');
  });
});
