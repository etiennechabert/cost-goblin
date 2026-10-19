import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsShell } from '../components/settings-shell.js';
import { SETTINGS_TABS } from '../settings/registry.js';
import type { SettingsTabId } from '../settings/registry.js';

afterEach(cleanup);

const FIRST = SETTINGS_TABS[0];
const LAST = SETTINGS_TABS.at(-1);
const SECOND = SETTINGS_TABS[1];

function tabButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

function renderShell(activeTab: SettingsTabId, onTabChange = vi.fn<(id: SettingsTabId) => void>()) {
  render(
    <SettingsShell tabs={SETTINGS_TABS} activeTab={activeTab} onTabChange={onTabChange}>
      <div>panel</div>
    </SettingsShell>,
  );
  return onTabChange;
}

/** Applies every tab change, like the real host does when nothing blocks it. */
function Host({ initial, blocked = false }: Readonly<{ initial: SettingsTabId; blocked?: boolean }>) {
  const [active, setActive] = useState<SettingsTabId>(initial);
  return (
    <SettingsShell tabs={SETTINGS_TABS} activeTab={active} onTabChange={(id) => { if (!blocked) setActive(id); }}>
      <div>panel for {active}</div>
    </SettingsShell>
  );
}

describe('SettingsShell — keyboard navigation', () => {
  if (FIRST === undefined || SECOND === undefined || LAST === undefined) throw new Error('registry has fewer than two tabs');

  it('moves to the next tab with ArrowDown and wraps from the last to the first', () => {
    const onTabChange = renderShell(FIRST.id);
    fireEvent.keyDown(tabButton(FIRST.label), { key: 'ArrowDown' });
    expect(onTabChange).toHaveBeenLastCalledWith(SECOND.id);
    cleanup();

    const fromLast = renderShell(LAST.id);
    fireEvent.keyDown(tabButton(LAST.label), { key: 'ArrowDown' });
    expect(fromLast).toHaveBeenLastCalledWith(FIRST.id);
  });

  it('moves to the previous tab with ArrowUp and wraps from the first to the last', () => {
    const onTabChange = renderShell(SECOND.id);
    fireEvent.keyDown(tabButton(SECOND.label), { key: 'ArrowUp' });
    expect(onTabChange).toHaveBeenLastCalledWith(FIRST.id);
    cleanup();

    const fromFirst = renderShell(FIRST.id);
    fireEvent.keyDown(tabButton(FIRST.label), { key: 'ArrowUp' });
    expect(fromFirst).toHaveBeenLastCalledWith(LAST.id);
  });

  it('jumps to the first tab with Home and the last with End', () => {
    const onTabChange = renderShell(SECOND.id);
    fireEvent.keyDown(tabButton(SECOND.label), { key: 'Home' });
    expect(onTabChange).toHaveBeenLastCalledWith(FIRST.id);
    fireEvent.keyDown(tabButton(SECOND.label), { key: 'End' });
    expect(onTabChange).toHaveBeenLastCalledWith(LAST.id);
  });

  it('claims the arrow keys from the page, and leaves every other key alone', () => {
    const onTabChange = renderShell(FIRST.id);
    expect(fireEvent.keyDown(tabButton(FIRST.label), { key: 'ArrowDown', cancelable: true })).toBe(false);
    expect(fireEvent.keyDown(tabButton(FIRST.label), { key: 'a', cancelable: true })).toBe(true);
    expect(fireEvent.keyDown(tabButton(FIRST.label), { key: 'Enter', cancelable: true })).toBe(true);
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the active tab is not one of the rail s tabs', () => {
    const onTabChange = vi.fn<(id: SettingsTabId) => void>();
    const others = SETTINGS_TABS.filter(t => t.id !== FIRST.id);
    render(
      <SettingsShell tabs={others} activeTab={FIRST.id} onTabChange={onTabChange}>
        <div>panel</div>
      </SettingsShell>,
    );
    fireEvent.keyDown(tabButton(SECOND.label), { key: 'ArrowDown' });
    expect(onTabChange).not.toHaveBeenCalled();
    // No tab in the rail is marked current, and every tab is out of the tab order.
    expect(document.querySelector('[aria-current="page"]')).toBeNull();
    for (const t of others) expect(tabButton(t.label).getAttribute('tabindex')).toBe('-1');
  });
});

describe('SettingsShell — focus follows the active tab', () => {
  if (FIRST === undefined || SECOND === undefined) throw new Error('registry has fewer than two tabs');

  it('moves focus onto the tab the arrow key activated', async () => {
    render(<Host initial={FIRST.id} />);
    const user = userEvent.setup();
    await user.click(tabButton(FIRST.label));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByText(`panel for ${SECOND.id}`)).toBeDefined();
    expect(document.activeElement).toBe(tabButton(SECOND.label));
    expect(tabButton(SECOND.label).getAttribute('tabindex')).toBe('0');
  });

  it('leaves focus where it is when the host blocks the switch', async () => {
    render(<Host initial={FIRST.id} blocked />);
    const user = userEvent.setup();
    await user.click(tabButton(FIRST.label));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByText(`panel for ${FIRST.id}`)).toBeDefined();
    expect(document.activeElement).toBe(tabButton(FIRST.label));
  });

  it('never steals focus from outside the rail when the active tab changes', () => {
    const onTabChange = vi.fn<(id: SettingsTabId) => void>();
    const view = render(
      <>
        <button type="button">outside</button>
        <SettingsShell tabs={SETTINGS_TABS} activeTab={FIRST.id} onTabChange={onTabChange}><div>panel</div></SettingsShell>
      </>,
    );
    const outside = screen.getByRole('button', { name: 'outside' });
    act(() => { outside.focus(); });
    view.rerender(
      <>
        <button type="button">outside</button>
        <SettingsShell tabs={SETTINGS_TABS} activeTab={SECOND.id} onTabChange={onTabChange}><div>panel</div></SettingsShell>
      </>,
    );
    expect(document.activeElement).toBe(outside);
  });

  it('sticks the rail below the host s header', () => {
    render(
      <SettingsShell tabs={SETTINGS_TABS} activeTab={FIRST.id} onTabChange={vi.fn()} topOffset={64}>
        <div>panel</div>
      </SettingsShell>,
    );
    const rail = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(rail.style.top).toBe('64px');
    expect(rail.style.minHeight).toBe('calc(100vh - 64px)');
  });
});
