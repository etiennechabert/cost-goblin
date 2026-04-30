import { useEffect } from 'react';
import { matchesShortcut } from '../lib/keyboard-utils.js';

export function useKeyboardShortcuts(
  shortcuts: Readonly<Record<string, () => void>>,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent): void {
      for (const [shortcutString, handler] of Object.entries(shortcuts)) {
        const keys = shortcutString.split('+');
        if (matchesShortcut(event, keys)) {
          event.preventDefault();
          handler();
          break;
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('keydown', handleKeyDown); };
  }, [shortcuts, enabled]);
}
