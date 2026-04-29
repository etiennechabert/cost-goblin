import { useEffect } from 'react';
import { matchesShortcut } from '../lib/keyboard-utils.js';

/**
 * Register keyboard shortcuts that trigger callbacks when pressed.
 * Shortcuts are checked against keyboard events globally and the first
 * matching shortcut's handler is invoked. The default browser behavior
 * for matched shortcuts is prevented.
 *
 * @param shortcuts - Map of shortcut strings to handler functions.
 *   Keys use '+' to separate modifiers and the final key (e.g., 'Mod+k', 'Shift+Enter', 'Escape').
 *   Use 'Mod' for the platform-specific primary modifier (Cmd on macOS, Ctrl elsewhere).
 * @param enabled - Whether the shortcuts are active (default: true).
 *   When false, the event listener is not attached.
 *
 * @example
 * useKeyboardShortcuts({
 *   'Mod+k': () => setCommandPaletteOpen(true),
 *   'Escape': () => closePanel(),
 *   '1': () => navigateToView('overview'),
 *   'Shift+?': () => setShortcutsOverlayOpen(true),
 * });
 *
 * @example
 * // Disable shortcuts conditionally
 * useKeyboardShortcuts(
 *   { 'Mod+s': saveDocument },
 *   !isModalOpen // Only active when modal is closed
 * );
 */
export function useKeyboardShortcuts(
  shortcuts: Readonly<Record<string, () => void>>,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent): void {
      // Check each shortcut in order until we find a match
      for (const [shortcutString, handler] of Object.entries(shortcuts)) {
        const keys = shortcutString.split('+');
        if (matchesShortcut(event, keys)) {
          event.preventDefault();
          handler();
          break; // Only trigger the first matching shortcut
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('keydown', handleKeyDown); };
  }, [shortcuts, enabled]);
}
