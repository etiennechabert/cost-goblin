import { useCallback, useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { isAnotherModalLayerOpen, useRegisterModalLayer } from '../hooks/modal-layers.js';
import { useKeyboardShortcuts, formatShortcutLabel } from '../hooks/use-keyboard-shortcuts.js';
import type { Shortcut } from '../hooks/use-keyboard-shortcuts.js';
import { NO_DRAG, cn } from '../lib/utils.js';

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
  /** Extra fuzzy-match terms beyond the label (e.g. "dark mode" for the
   *  General settings tab) so intent-based search resolves to the right item. */
  readonly keywords?: readonly string[];
}

interface CommandPaletteProps {
  readonly items: readonly NavItem[];
  readonly onNavigate: (id: string) => void;
}

type PaletteState =
  | { readonly open: false }
  /** `opener` had focus when the palette opened; it gets it back on close. */
  | { readonly open: true; readonly opener: Element | null };

const CLOSED: PaletteState = { open: false };

export function CommandPalette({ items, onNavigate }: CommandPaletteProps) {
  const [state, setState] = useState<PaletteState>(CLOSED);
  const layer = useRegisterModalLayer(state.open, 'palette');

  const handleSelect = useCallback((id: string) => {
    setState(CLOSED);
    onNavigate(id);
  }, [onNavigate]);

  const shortcuts = useMemo((): readonly Shortcut[] => [
    {
      key: 'k',
      metaKey: true,
      label: 'Open command palette',
      action: () => {
        // Read before the palette's focus scope moves focus into its input.
        const opener = document.activeElement;
        // Cmd+K always closes the palette, but never opens it over another
        // modal: its navigations (switching workspace, leaving a dirty view)
        // would open a dialog under that modal's pointer lock and focus trap.
        setState((prev) => {
          if (prev.open) return CLOSED;
          return isAnotherModalLayerOpen(layer) ? prev : { open: true, opener };
        });
      },
    },
  ], [layer]);

  useKeyboardShortcuts(shortcuts);

  // Radix restores focus on close only to a dialog Trigger, which the palette
  // does not have, so focus would drop to <body>. Give it back to the opener
  // once the palette has closed — after Radix's own close-time focus handling,
  // which runs a tick after unmount — unless what the palette navigated to
  // took focus itself (a confirm dialog focuses its Cancel).
  const opener = state.open ? state.opener : null;
  useEffect(() => {
    if (!(opener instanceof HTMLElement)) return undefined;
    return () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if ((active === null || active === document.body) && opener.isConnected) opener.focus();
      }, 0);
    };
  }, [opener]);

  const grouped = useMemo(() => {
    const groups = new Map<string, NavItem[]>();
    for (const item of items) {
      const group = item.group ?? 'Navigation';
      const list = groups.get(group);
      if (list === undefined) {
        groups.set(group, [item]);
      } else {
        list.push(item);
      }
    }
    return groups;
  }, [items]);

  return (
    <Command.Dialog
      open={state.open}
      onOpenChange={(next) => { if (!next) setState(CLOSED); }}
      label="Command palette"
      loop
      // no-drag: the overlay covers the app header, a window drag region —
      // without the opt-out, clicks there would drag the window instead of
      // dismissing the palette.
      overlayClassName={cn('fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm', NO_DRAG)}
      contentClassName={cn('fixed left-1/2 top-[20%] z-[100] w-full max-w-lg -translate-x-1/2 rounded-xl border border-border bg-bg-secondary shadow-2xl', NO_DRAG)}
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="h-4 w-4 shrink-0 text-text-secondary" />
        <Command.Input
          placeholder="Type to search..."
          className="flex h-11 w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary outline-none"
        />
        <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border bg-bg-tertiary px-1.5 text-[10px] font-medium text-text-secondary">
          {formatShortcutLabel({ key: 'K', metaKey: true, label: '', action: () => undefined })}
        </kbd>
      </div>
      <Command.List className="max-h-72 overflow-y-auto p-2">
        <Command.Empty className="py-6 text-center text-sm text-text-secondary">
          No results found.
        </Command.Empty>
        {[...grouped.entries()].map(([group, groupItems]) => (
          <Command.Group
            key={group}
            heading={group}
            className="[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-secondary [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
          >
            {groupItems.map((item) => (
              <Command.Item
                key={item.id}
                value={item.id}
                keywords={[item.label, ...(item.keywords ?? [])]}
                onSelect={handleSelect}
                className="relative flex cursor-pointer items-center rounded-lg px-2 py-2 text-sm text-text-primary outline-none data-[selected=true]:bg-bg-tertiary"
              >
                {item.label}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
