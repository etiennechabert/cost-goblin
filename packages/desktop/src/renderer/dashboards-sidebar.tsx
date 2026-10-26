import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { PanelLeftOpen, Pin, Star } from 'lucide-react';
import { ButtonTooltip } from '@costgoblin/ui';

export interface DashboardItem {
  readonly id: string;
  readonly name: string;
}

interface RowsProps {
  readonly items: readonly DashboardItem[];
  readonly activeId: string;
  readonly defaultId: string;
  readonly onSelect: (id: string) => void;
  readonly onSetDefault: (id: string) => void;
}

interface Props extends RowsProps {
  /** Pixel offset of the sticky app header, so the sidebar sits just below it. */
  readonly topOffset: number;
  /** Pinned, the sidebar keeps a column beside the dashboard. Unpinned, it
   *  stays hidden until the pointer rests on the window's left edge (or `open`
   *  is set from outside), then slides in over the dashboard. */
  readonly pinned: boolean;
  readonly onPinnedChange: (pinned: boolean) => void;
  /** Whether the unpinned sidebar is shown. Unused while pinned. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The button that shows and hides the unpinned sidebar (the top bar's
   *  Dashboards button). Focus moving to it is the toggle's click starting,
   *  not focus leaving the sidebar. */
  readonly toggleRef: React.RefObject<HTMLElement | null>;
  /** The list's id, for the toggle's aria-controls. */
  readonly id: string;
}

/** How long the pointer rests on the left edge before the unpinned sidebar
 *  slides in, so a pointer only passing through, out of the window, leaves it
 *  hidden. */
export const REVEAL_DELAY_MS = 150;

/** The dashboard's own padding (CustomView's `p-6`), so the edge tab sits
 *  level with its title. */
const VIEW_PADDING_PX = 24;

/** How long the unpinned sidebar stays after the pointer leaves it, so a
 *  pointer overshooting its edge can come back. */
export const HIDE_DELAY_MS = 300;

function cancel(timer: { current: ReturnType<typeof setTimeout> | null }): void {
  if (timer.current === null) return;
  clearTimeout(timer.current);
  timer.current = null;
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
 *  one Home opens), which is listed first. The pin in its header keeps the
 *  list in a column of its own, or hides it until it is wanted. */
export function DashboardsSidebar({
  items,
  activeId,
  defaultId,
  onSelect,
  onSetDefault,
  topOffset,
  pinned,
  onPinnedChange,
  open,
  onOpenChange,
  toggleRef,
  id,
}: Readonly<Props>): React.JSX.Element {
  const rows: RowsProps = { items, activeId, defaultId, onSelect, onSetDefault };
  return pinned
    ? <DockedSidebar id={id} rows={rows} topOffset={topOffset} onPinnedChange={onPinnedChange} />
    : (
      <PeekSidebar
        id={id}
        rows={rows}
        topOffset={topOffset}
        onPinnedChange={onPinnedChange}
        open={open}
        onOpenChange={onOpenChange}
        toggleRef={toggleRef}
      />
    );
}

interface DockedProps {
  readonly id: string;
  readonly rows: RowsProps;
  readonly topOffset: number;
  readonly onPinnedChange: (pinned: boolean) => void;
}

function DockedSidebar({ id, rows, topOffset, onPinnedChange }: DockedProps): React.JSX.Element {
  return (
    // Scrolls on its own when the list outgrows the window, so a long list
    // never stretches the page below the dashboard.
    <nav
      id={id}
      aria-label="Dashboards"
      className="sticky w-56 shrink-0 self-start overflow-y-auto border-r border-border bg-bg-secondary/40 p-3"
      style={{
        top: topOffset,
        minHeight: `calc(100vh - ${String(topOffset)}px)`,
        maxHeight: `calc(100vh - ${String(topOffset)}px)`,
      }}
    >
      <SidebarHeader pinned onPinnedChange={onPinnedChange} />
      <DashboardRows {...rows} />
    </nav>
  );
}

interface PeekProps extends DockedProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly toggleRef: React.RefObject<HTMLElement | null>;
}

/** The unpinned sidebar: a thin strip along the window's left edge, marked
 *  by a tab level with the dashboard's title, reveals it, and it slides in over the dashboard instead of taking a column, so the
 *  widgets keep the full width. It hides again shortly after the pointer
 *  leaves it, once a dashboard is picked, on Escape, or when focus moves out. */
function PeekSidebar({ id, rows, topOffset, onPinnedChange, open, onOpenChange, toggleRef }: PeekProps): React.JSX.Element {
  const navRef = useRef<HTMLElement>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInside = useRef(false);
  // The pointer opened it, so focus stays where it is.
  const openedByPointer = useRef(false);
  // Shown from outside (the top bar's Dashboards button), focus moved in from
  // here, and goes back here on Escape or once a dashboard is picked.
  const returnFocus = useRef<HTMLElement | null>(null);
  // The timers answer with the newest callback, not the one from the render
  // that started them.
  const onOpenChangeRef = useRef(onOpenChange);
  useLayoutEffect(() => { onOpenChangeRef.current = onOpenChange; });

  // Off the screen (Settings over the dashboard, pinned, another page) is
  // closed, so it never comes back open by itself.
  useEffect(() => () => {
    cancel(revealTimer);
    cancel(hideTimer);
    onOpenChangeRef.current(false);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      openedByPointer.current = false;
      return;
    }
    if (openedByPointer.current) {
      returnFocus.current = null;
      return;
    }
    const previous = document.activeElement;
    returnFocus.current = previous instanceof HTMLElement ? previous : null;
    const nav = navRef.current;
    const row = nav?.querySelector('[aria-current="page"]') ?? nav?.querySelector('[data-dashboard-row]');
    if (row instanceof HTMLElement) row.focus();
  }, [open]);

  function hide(): void {
    cancel(revealTimer);
    cancel(hideTimer);
    onOpenChangeRef.current(false);
  }

  function hideSoon(): void {
    cancel(hideTimer);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      const hadFocus = navRef.current?.contains(document.activeElement) === true;
      onOpenChangeRef.current(false);
      // Hidden, the row holding focus would drop it to the page.
      if (hadFocus) giveFocusBack();
    }, HIDE_DELAY_MS);
  }

  function revealSoon(): void {
    if (open) return;
    cancel(revealTimer);
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      openedByPointer.current = true;
      onOpenChangeRef.current(true);
    }, REVEAL_DELAY_MS);
  }

  function leaveEdge(): void {
    cancel(revealTimer);
    // The sidebar slid in under a pointer resting on the edge, which then
    // left without crossing it: that is leaving too. Entering the sidebar
    // cancels this.
    if (open) hideSoon();
  }

  function giveFocusBack(): void {
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected === true) target.focus();
  }

  return (
    <>
      <div
        data-testid="dashboards-sidebar-edge"
        aria-hidden="true"
        className="fixed bottom-0 left-0 z-40 w-2"
        style={{ top: topOffset }}
        onPointerEnter={revealSoon}
        onPointerLeave={leaveEdge}
      />
      {/* The edge strip is invisible: this tab shows the sidebar is there.
          The pointer resting on it reveals the sidebar as the strip does, and
          a click (or Enter) shows it at once. The sidebar slides in over it. */}
      <button
        type="button"
        aria-label="Show the dashboards sidebar"
        aria-controls={id}
        aria-expanded={open}
        className={[
          'fixed left-0 z-40 flex h-10 w-5 items-center justify-center rounded-r-lg border border-l-0 border-text-muted/60 bg-bg-tertiary text-text-secondary transition-colors hover:text-text-primary',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
        ].join(' ')}
        style={{ top: topOffset + VIEW_PADDING_PX }}
        onPointerEnter={revealSoon}
        onPointerLeave={leaveEdge}
        onClick={() => {
          cancel(revealTimer);
          onOpenChangeRef.current(true);
        }}
      >
        <PanelLeftOpen size={14} />
      </button>
      <nav
        ref={navRef}
        id={id}
        aria-label="Dashboards"
        className={[
          'fixed bottom-0 left-0 z-40 w-56 overflow-y-auto border-r border-border bg-bg-secondary p-3 shadow-xl',
          // Visibility flips at the end of the slide out and at the start of
          // the slide in, so a hidden sidebar is out of the tab order and the
          // accessibility tree.
          'transition-[translate,visibility] duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
        style={{ top: topOffset, visibility: open ? 'visible' : 'hidden' }}
        onPointerEnter={() => {
          pointerInside.current = true;
          cancel(hideTimer);
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
          if (open) hideSoon();
        }}
        onKeyDown={(event) => {
          // An Escape that closed a tooltip in the sidebar closes only that.
          if (event.key !== 'Escape' || event.isDefaultPrevented()) return;
          hide();
          giveFocusBack();
        }}
        onBlur={(event) => {
          // Switching apps blurs the focused row but leaves it the focused
          // element: the list is still in use.
          if (event.target.ownerDocument.activeElement === event.target) return;
          const next = event.relatedTarget;
          if (next instanceof Node && navRef.current?.contains(next) === true) return;
          // The toggle's own click is on its way and decides.
          if (next instanceof Node && toggleRef.current?.contains(next) === true) return;
          // A click on the sidebar's padding drops focus, but the pointer is
          // still on it: that is not leaving.
          if (pointerInside.current) return;
          returnFocus.current = null;
          hide();
        }}
      >
        <SidebarHeader pinned={false} onPinnedChange={onPinnedChange} />
        <DashboardRows
          {...rows}
          onSelect={(id) => {
            hide();
            rows.onSelect(id);
            giveFocusBack();
          }}
        />
      </nav>
    </>
  );
}

function SidebarHeader({ pinned, onPinnedChange }: Readonly<{ pinned: boolean; onPinnedChange: (pinned: boolean) => void }>): React.JSX.Element {
  return (
    <div className="mb-1 flex items-center justify-between gap-2 pl-2.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Dashboards</span>
      <ButtonTooltip
        name="Pin sidebar"
        description={pinned ? 'Unpin to show it only when you point at the left edge' : 'Keep it open beside the dashboard'}
      >
        <button
          type="button"
          onClick={() => { onPinnedChange(!pinned); }}
          aria-label="Pin sidebar"
          aria-pressed={pinned}
          className={[
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary',
            pinned ? 'text-accent' : 'text-text-muted hover:bg-bg-tertiary/50 hover:text-text-primary',
          ].join(' ')}
        >
          <Pin size={14} fill={pinned ? 'currentColor' : 'none'} />
        </button>
      </ButtonTooltip>
    </div>
  );
}

function DashboardRows({ items, activeId, defaultId, onSelect, onSetDefault }: RowsProps): React.JSX.Element {
  const sorted = useMemo(() => {
    const def = items.find(i => i.id === defaultId);
    const rest = items.filter(i => i.id !== defaultId);
    return def === undefined ? rest : [def, ...rest];
  }, [items, defaultId]);

  return (
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
              data-dashboard-row
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
  );
}
