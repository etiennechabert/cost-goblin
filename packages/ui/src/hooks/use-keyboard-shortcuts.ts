import { useEffect } from 'react';

export interface Shortcut {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly label: string;
  readonly action: () => void;
}

function isInputElement(target: EventTarget | null): boolean {
  if (target === null) return false;
  const el = target as Element;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if ('isContentEditable' in el && (el as HTMLElement).isContentEditable) return true;
  return false;
}

export function matchesShortcut(e: KeyboardEvent, shortcut: Shortcut): boolean {
  if (e.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  if (shortcut.metaKey === true && !e.metaKey) return false;
  if (shortcut.ctrlKey === true && !e.ctrlKey) return false;
  return true;
}

export function formatShortcutLabel(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.metaKey === true) parts.push('\u2318');
  if (shortcut.ctrlKey === true) parts.push('Ctrl');
  parts.push(shortcut.key.toUpperCase());
  return parts.join('');
}

export function useKeyboardShortcuts(shortcuts: readonly Shortcut[]): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+K always works (even in inputs) since it opens the palette
      const isCmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey);

      if (!isCmdK && isInputElement(e.target)) return;

      for (const shortcut of shortcuts) {
        if (matchesShortcut(e, shortcut)) {
          e.preventDefault();
          shortcut.action();
          return;
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('keydown', handleKeyDown); };
  }, [shortcuts]);
}
