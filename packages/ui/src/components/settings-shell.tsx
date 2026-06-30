import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { SettingsTabId, SettingsTabMeta } from '../settings/registry.js';

interface SettingsShellProps {
  readonly tabs: readonly SettingsTabMeta[];
  readonly activeTab: SettingsTabId;
  readonly onTabChange: (id: SettingsTabId) => void;
  /** Pixel offset of the sticky app header, so the rail sticks just below it. */
  readonly topOffset?: number;
  /** The active tab's content (rendered by the host so it can inject
   *  app-specific tabs like General without leaking Electron deps into ui). */
  readonly children: ReactNode;
}

/** Full-canvas settings layout: a vertical tab rail on the left and the active
 *  tab's content on the right. Purely presentational and registry-driven — it
 *  owns no app state, so it works the same in desktop and (future) web mode.
 *
 *  The rail is a roving-tabindex vertical list using `aria-current` to mark the
 *  active section (NOT a menu/listbox — these are navigation links). */
export function SettingsShell({
  tabs,
  activeTab,
  onTabChange,
  topOffset = 0,
  children,
}: SettingsShellProps): React.JSX.Element {
  const railRef = useRef<HTMLElement>(null);

  // Keep keyboard focus on whichever tab is actually active. Driven by
  // `activeTab` (not the keydown handler) so a tab switch that the host blocks
  // — e.g. a confirm-leave guard on a dirty editor — leaves focus on the
  // current tab instead of stranding it on one that never activated. Only acts
  // when focus is already inside the rail, so it never steals focus on mount.
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null || !rail.contains(document.activeElement)) return;
    rail.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.focus();
  }, [activeTab]);

  function handleRailKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const current = tabs.findIndex(t => t.id === activeTab);
    if (current === -1) return;
    let next: number;
    if (e.key === 'ArrowDown') next = (current + 1) % tabs.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else next = tabs.length - 1;
    const target = tabs[next];
    if (target === undefined) return;
    onTabChange(target.id);
  }

  return (
    <div className="flex items-start">
      <nav
        ref={railRef}
        aria-label="Settings sections"
        className="sticky w-56 shrink-0 self-start border-r border-border bg-bg-secondary/40 p-3"
        style={{ top: topOffset, minHeight: `calc(100vh - ${String(topOffset)}px)` }}
      >
        <ul className="flex flex-col gap-0.5">
          {tabs.map((tab) => {
            const Icon = tab.Icon;
            const isActive = tab.id === activeTab;
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  data-tab={tab.id}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => { onTabChange(tab.id); }}
                  onKeyDown={handleRailKeyDown}
                  aria-current={isActive ? 'page' : undefined}
                  className={[
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
                    isActive
                      ? 'bg-bg-tertiary font-medium text-text-primary'
                      : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary',
                  ].join(' ')}
                >
                  <Icon size={17} className={isActive ? 'text-accent' : undefined} />
                  <span className="flex-1 text-left">{tab.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
