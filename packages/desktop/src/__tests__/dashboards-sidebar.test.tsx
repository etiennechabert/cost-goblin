import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardsSidebar, HIDE_DELAY_MS, REVEAL_DELAY_MS, resolveLastDashboard } from '../renderer/dashboards-sidebar.js';
import type { DashboardItem } from '../renderer/dashboards-sidebar.js';

type User = ReturnType<typeof userEvent.setup>;

const ITEMS: readonly DashboardItem[] = [
  { id: 'overview', name: 'Overview' },
  { id: 'teams', name: 'Team costs' },
  { id: 'k8s', name: 'Kubernetes' },
];

function renderSidebar(fields: Partial<Parameters<typeof DashboardsSidebar>[0]> = {}): {
  user: User;
  onSelect: ReturnType<typeof vi.fn>;
  onSetDefault: ReturnType<typeof vi.fn>;
  onPinnedChange: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const onSetDefault = vi.fn();
  const onPinnedChange = vi.fn();
  const user = userEvent.setup();
  render(
    <DashboardsSidebar
      items={ITEMS}
      activeId="overview"
      defaultId="teams"
      onSelect={onSelect}
      onSetDefault={onSetDefault}
      topOffset={0}
      pinned
      onPinnedChange={onPinnedChange}
      open={false}
      onOpenChange={() => undefined}
      toggleRef={{ current: null }}
      id="dashboards-sidebar"
      {...fields}
    />,
  );
  return { user, onSelect, onSetDefault, onPinnedChange };
}

/** The unpinned sidebar as the app shell drives it: the open state held above
 *  it, a toggle standing in for the top bar's Dashboards button, and some
 *  dashboard content to click away to. */
function renderUnpinned(): {
  user: User;
  onSelect: ReturnType<typeof vi.fn>;
  onSetDefault: ReturnType<typeof vi.fn>;
  onPinnedChange: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const onSetDefault = vi.fn();
  const onPinnedChange = vi.fn();
  function Shell(): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const toggleRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={toggleRef} type="button" onClick={() => { setOpen(!open); }}>Show dashboards</button>
        <DashboardsSidebar
          items={ITEMS}
          activeId="teams"
          defaultId="teams"
          onSelect={onSelect}
          onSetDefault={onSetDefault}
          topOffset={72}
          pinned={false}
          onPinnedChange={onPinnedChange}
          open={open}
          onOpenChange={setOpen}
          toggleRef={toggleRef}
          id="dashboards-sidebar"
        />
        <p>Dashboard content</p>
      </>
    );
  }
  const user = userEvent.setup();
  render(<Shell />);
  return { user, onSelect, onSetDefault, onPinnedChange };
}

function sidebar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Dashboards' });
}

/** The sidebar while it is shown; null while it is hidden (and so out of the
 *  accessibility tree and the tab order). */
function shownSidebar(): HTMLElement | null {
  return screen.queryByRole('navigation', { name: 'Dashboards' });
}

function edge(): HTMLElement {
  return screen.getByTestId('dashboards-sidebar-edge');
}

/** The tab on the window's left edge that says the unpinned sidebar is there. */
function edgeTab(): HTMLElement {
  return screen.getByRole('button', { name: 'Show the dashboards sidebar' });
}

function advance(ms: number): void {
  act(() => { vi.advanceTimersByTime(ms); });
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

  it('unpins from its header', async () => {
    const { user, onPinnedChange } = renderSidebar();
    const pin = within(sidebar()).getByRole('button', { name: 'Pin sidebar' });
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    await user.click(pin);
    expect(onPinnedChange).toHaveBeenCalledWith(false);
  });

  it('pinned, it has no edge to hover', () => {
    renderSidebar();
    expect(screen.queryByTestId('dashboards-sidebar-edge')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show the dashboards sidebar' })).toBeNull();
  });
});

describe('DashboardsSidebar — unpinned', () => {
  it('floats over the dashboard, below the header', async () => {
    const { user } = renderUnpinned();
    expect(shownSidebar()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show dashboards' }));
    const nav = sidebar();
    expect(nav.className).toContain('fixed');
    expect(nav.style.top).toBe('72px');
    expect(edge().style.top).toBe('72px');
    // Its slide is a CSS transition that reduced motion turns off.
    expect(nav.className).toContain('motion-reduce:transition-none');
  });

  it('shows a tab on the left edge, level with the dashboard title, that opens it', async () => {
    const { user } = renderUnpinned();
    const tab = edgeTab();
    expect(tab.className).toContain('fixed');
    // The dashboard's 24px padding, below the 72px header.
    expect(tab.style.top).toBe('96px');
    expect(tab.getAttribute('aria-controls')).toBe('dashboards-sidebar');
    expect(tab.getAttribute('aria-expanded')).toBe('false');

    await user.click(tab);
    expect(shownSidebar()).not.toBeNull();
    expect(tab.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(sidebar()).getByRole('button', { name: 'Team costs' }));

    await user.keyboard('{Escape}');
    expect(shownSidebar()).toBeNull();
    expect(document.activeElement).toBe(tab);
  });

  it('closes once a dashboard is picked, but not for a star', async () => {
    const { user, onSelect, onSetDefault } = renderUnpinned();
    await user.click(screen.getByRole('button', { name: 'Show dashboards' }));

    await user.click(within(sidebar()).getByRole('button', { name: 'Set Kubernetes as default' }));
    expect(onSetDefault).toHaveBeenCalledWith('k8s');
    expect(shownSidebar()).not.toBeNull();

    await user.click(within(sidebar()).getByRole('button', { name: 'Overview' }));
    expect(onSelect).toHaveBeenCalledWith('overview');
    expect(shownSidebar()).toBeNull();
  });

  it('shown from the Dashboards button, it takes focus and gives it back on Escape', async () => {
    const { user } = renderUnpinned();
    const trigger = screen.getByRole('button', { name: 'Show dashboards' });
    await user.click(trigger);
    expect(document.activeElement).toBe(within(sidebar()).getByRole('button', { name: 'Team costs' }));

    await user.keyboard('{Escape}');
    expect(shownSidebar()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('the Dashboards button hides it again', async () => {
    const { user } = renderUnpinned();
    const trigger = screen.getByRole('button', { name: 'Show dashboards' });
    await user.click(trigger);
    expect(shownSidebar()).not.toBeNull();

    // Focus leaves the sidebar for the button first; its click decides.
    await user.click(trigger);
    expect(shownSidebar()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('stays open while the user switches to another app', async () => {
    const { user } = renderUnpinned();
    await user.click(screen.getByRole('button', { name: 'Show dashboards' }));
    const row = within(sidebar()).getByRole('button', { name: 'Team costs' });
    // The window losing focus blurs the row, which stays the focused element.
    fireEvent.focusOut(row, { relatedTarget: null });
    expect(document.activeElement).toBe(row);
    expect(shownSidebar()).not.toBeNull();
  });

  it('closes when focus moves out of it', async () => {
    const { user } = renderUnpinned();
    await user.click(screen.getByRole('button', { name: 'Show dashboards' }));
    expect(shownSidebar()).not.toBeNull();

    await user.click(screen.getByText('Dashboard content'));
    expect(shownSidebar()).toBeNull();
  });

  it('pins from its header while shown', async () => {
    const { user, onPinnedChange } = renderUnpinned();
    await user.click(screen.getByRole('button', { name: 'Show dashboards' }));
    const pin = within(sidebar()).getByRole('button', { name: 'Pin sidebar' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await user.click(pin);
    expect(onPinnedChange).toHaveBeenCalledWith(true);
  });

  // Synchronous pointer events under fake timers, so each delay is exact.
  describe('on the pointer', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('stays hidden until the pointer rests on the window\'s left edge', () => {
      renderUnpinned();
      fireEvent.pointerEnter(edge());
      advance(REVEAL_DELAY_MS - 1);
      expect(shownSidebar()).toBeNull();
      advance(1);
      expect(shownSidebar()).not.toBeNull();
    });

    it('shows for a pointer resting on the edge tab, as on the edge', () => {
      renderUnpinned();
      fireEvent.pointerEnter(edgeTab());
      advance(REVEAL_DELAY_MS - 1);
      expect(shownSidebar()).toBeNull();
      advance(1);
      expect(shownSidebar()).not.toBeNull();

      fireEvent.pointerLeave(edgeTab());
      advance(HIDE_DELAY_MS);
      expect(shownSidebar()).toBeNull();
    });

    it('a click on the edge tab opens it at once, and the pending reveal does not reopen it', () => {
      renderUnpinned();
      const tab = edgeTab();
      fireEvent.pointerEnter(tab);
      act(() => { tab.focus(); });
      fireEvent.click(tab);
      expect(shownSidebar()).not.toBeNull();

      fireEvent.keyDown(sidebar(), { key: 'Escape' });
      expect(shownSidebar()).toBeNull();
      advance(REVEAL_DELAY_MS);
      expect(shownSidebar()).toBeNull();
    });

    it('ignores a pointer that only passes over the edge', () => {
      renderUnpinned();
      fireEvent.pointerEnter(edge());
      fireEvent.pointerLeave(edge());
      advance(REVEAL_DELAY_MS * 2);
      expect(shownSidebar()).toBeNull();
    });

    it('hides shortly after the pointer leaves it, unless the pointer comes back', () => {
      renderUnpinned();
      fireEvent.pointerEnter(edge());
      advance(REVEAL_DELAY_MS);
      const nav = sidebar();
      fireEvent.pointerEnter(nav);

      fireEvent.pointerLeave(nav);
      advance(HIDE_DELAY_MS - 1);
      fireEvent.pointerEnter(nav);
      advance(HIDE_DELAY_MS);
      expect(shownSidebar()).not.toBeNull();

      fireEvent.pointerLeave(nav);
      advance(HIDE_DELAY_MS);
      expect(shownSidebar()).toBeNull();
    });

    // It slid in under a pointer resting on the edge, so the pointer's next
    // move leaves the edge strip: onto the sidebar, or straight away from it.
    it('stays for a pointer that moves from the edge onto it', () => {
      renderUnpinned();
      fireEvent.pointerEnter(edge());
      advance(REVEAL_DELAY_MS);
      fireEvent.pointerLeave(edge());
      fireEvent.pointerEnter(sidebar());
      advance(HIDE_DELAY_MS);
      expect(shownSidebar()).not.toBeNull();
    });

    it('gives focus back to the Dashboards button when it hides with focus inside', () => {
      renderUnpinned();
      const trigger = screen.getByRole('button', { name: 'Show dashboards' });
      act(() => { trigger.focus(); });
      fireEvent.click(trigger);
      const nav = sidebar();
      expect(document.activeElement).toBe(within(nav).getByRole('button', { name: 'Team costs' }));

      fireEvent.pointerEnter(nav);
      fireEvent.pointerLeave(nav);
      advance(HIDE_DELAY_MS);
      expect(shownSidebar()).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('hides for a pointer that leaves the edge without coming onto it', () => {
      renderUnpinned();
      fireEvent.pointerEnter(edge());
      advance(REVEAL_DELAY_MS);
      fireEvent.pointerLeave(edge());
      advance(HIDE_DELAY_MS);
      expect(shownSidebar()).toBeNull();
    });
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
