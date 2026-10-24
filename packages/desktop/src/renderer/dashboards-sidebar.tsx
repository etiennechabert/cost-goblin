import { useMemo } from 'react';
import { Star } from 'lucide-react';

export interface DashboardItem {
  readonly id: string;
  readonly name: string;
}

interface Props {
  items: readonly DashboardItem[];
  activeId: string;
  defaultId: string;
  onSelect: (id: string) => void;
  onSetDefault: (id: string) => void;
  /** Pixel offset of the sticky app header, so the sidebar sticks just below it. */
  topOffset: number;
}

/** The dashboard the top bar's Dashboards button reopens: the last one viewed
 *  while it still exists, else the default. */
export function resolveLastDashboard(
  lastId: string | null,
  items: readonly DashboardItem[],
  fallbackId: string,
): string {
  return lastId !== null && items.some(i => i.id === lastId) ? lastId : fallbackId;
}

/** The dashboards list beside an open dashboard, laid out like the Settings
 *  rail. Each row opens its dashboard, and its star makes it the default (the
 *  one Home opens), which is listed first. */
export function DashboardsSidebar({
  items,
  activeId,
  defaultId,
  onSelect,
  onSetDefault,
  topOffset,
}: Readonly<Props>): React.JSX.Element {
  const sorted = useMemo(() => {
    const def = items.find(i => i.id === defaultId);
    const rest = items.filter(i => i.id !== defaultId);
    return def === undefined ? rest : [def, ...rest];
  }, [items, defaultId]);

  return (
    // Scrolls on its own when the list outgrows the window, so a long list
    // never stretches the page below the dashboard.
    <nav
      aria-label="Dashboards"
      className="sticky w-56 shrink-0 self-start overflow-y-auto border-r border-border bg-bg-secondary/40 p-3"
      style={{
        top: topOffset,
        minHeight: `calc(100vh - ${String(topOffset)}px)`,
        maxHeight: `calc(100vh - ${String(topOffset)}px)`,
      }}
    >
      <ul className="flex flex-col gap-0.5">
        {sorted.map((item) => {
          const isDefault = item.id === defaultId;
          const isActive = item.id === activeId;
          return (
            <li key={item.id} className="flex items-stretch gap-0.5">
              <button
                type="button"
                onClick={() => { onSetDefault(item.id); }}
                className={[
                  'flex w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                  isDefault
                    ? 'text-accent'
                    : 'text-text-muted hover:text-accent hover:bg-bg-tertiary/50',
                ].join(' ')}
                aria-label={isDefault ? `${item.name} is the default dashboard` : `Set ${item.name} as default`}
                title={isDefault ? 'Default dashboard' : 'Set as default'}
                disabled={isDefault}
              >
                <Star size={14} fill={isDefault ? 'currentColor' : 'none'} />
              </button>
              <button
                type="button"
                onClick={() => { onSelect(item.id); }}
                title={item.name}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'min-w-0 flex-1 truncate rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
                  isActive
                    ? 'bg-bg-tertiary font-medium text-text-primary'
                    : 'text-text-secondary hover:bg-bg-tertiary/50 hover:text-text-primary',
                ].join(' ')}
              >
                {item.name}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
