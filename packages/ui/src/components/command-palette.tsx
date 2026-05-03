import { useCallback, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { useKeyboardShortcuts, formatShortcutLabel } from '../hooks/use-keyboard-shortcuts.js';
import type { Shortcut } from '../hooks/use-keyboard-shortcuts.js';

export interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly group?: string;
}

interface CommandPaletteProps {
  readonly items: readonly NavItem[];
  readonly onNavigate: (id: string) => void;
}

export function CommandPalette({ items, onNavigate }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = useCallback((id: string) => {
    setOpen(false);
    onNavigate(id);
  }, [onNavigate]);

  const shortcuts = useMemo((): readonly Shortcut[] => [
    { key: 'k', metaKey: true, label: 'Open command palette', action: () => { setOpen(prev => !prev); } },
  ], []);

  useKeyboardShortcuts(shortcuts);

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
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      loop
      overlayClassName="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[20%] z-[100] w-full max-w-lg -translate-x-1/2 rounded-xl border border-border bg-bg-secondary shadow-2xl"
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
                keywords={[item.label]}
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
