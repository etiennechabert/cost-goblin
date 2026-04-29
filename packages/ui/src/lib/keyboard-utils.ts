/**
 * Keyboard utility functions for cross-platform keyboard shortcut handling.
 * Handles differences between macOS (Cmd) and Windows/Linux (Ctrl).
 */

/**
 * Detects if the current platform is macOS.
 * Checks navigator.platform and navigator.userAgent for compatibility.
 */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  // Check platform first (more reliable when available)
  if (navigator.platform) {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  }

  // Fallback to userAgent
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

/**
 * Returns the primary modifier key for the current platform.
 * @returns 'Cmd' on macOS, 'Ctrl' on Windows/Linux
 */
export function getModifierKey(): 'Cmd' | 'Ctrl' {
  return isMac() ? 'Cmd' : 'Ctrl';
}

/**
 * Formats an array of key names into a human-readable shortcut string.
 * Automatically uses the correct modifier key for the platform.
 *
 * @param keys - Array of key names (e.g., ['Mod', 'K'] or ['Shift', 'Enter'])
 * @returns Formatted shortcut string (e.g., 'Cmd+K' on Mac, 'Ctrl+K' on Windows)
 *
 * @example
 * formatShortcut(['Mod', 'K']) // 'Cmd+K' on Mac, 'Ctrl+K' on Windows
 * formatShortcut(['Shift', 'Enter']) // 'Shift+Enter'
 * formatShortcut(['Escape']) // 'Escape'
 */
export function formatShortcut(keys: readonly string[]): string {
  if (keys.length === 0) {
    return '';
  }

  return keys
    .map((key) => {
      // Replace 'Mod' with platform-specific modifier
      if (key === 'Mod') {
        return getModifierKey();
      }
      return key;
    })
    .join('+');
}

/**
 * Checks if a keyboard event matches a shortcut definition.
 * Supports platform-agnostic 'Mod' key (Cmd on Mac, Ctrl elsewhere).
 *
 * @param event - Keyboard event to check
 * @param shortcut - Array of key names defining the shortcut
 * @returns true if the event matches the shortcut
 *
 * @example
 * matchesShortcut(event, ['Mod', 'k']) // Matches Cmd+K on Mac, Ctrl+K on Windows
 * matchesShortcut(event, ['Escape']) // Matches Escape key
 * matchesShortcut(event, ['Shift', 'Enter']) // Matches Shift+Enter
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: readonly string[]
): boolean {
  if (shortcut.length === 0) {
    return false;
  }

  // Extract the actual key (last element) and modifiers
  const modifiers = shortcut.slice(0, -1);
  const key = shortcut[shortcut.length - 1];

  if (!key) {
    return false;
  }

  // Check if the key matches (case-insensitive)
  const eventKey = event.key.toLowerCase();
  const targetKey = key.toLowerCase();

  if (eventKey !== targetKey) {
    return false;
  }

  // Check each modifier
  for (const modifier of modifiers) {
    const normalizedModifier = modifier.toLowerCase();

    if (normalizedModifier === 'mod') {
      // 'Mod' means metaKey on Mac, ctrlKey elsewhere
      const modPressed = isMac() ? event.metaKey : event.ctrlKey;
      if (!modPressed) {
        return false;
      }
    } else if (normalizedModifier === 'ctrl') {
      if (!event.ctrlKey) {
        return false;
      }
    } else if (normalizedModifier === 'alt') {
      if (!event.altKey) {
        return false;
      }
    } else if (normalizedModifier === 'shift') {
      if (!event.shiftKey) {
        return false;
      }
    } else if (normalizedModifier === 'meta' || normalizedModifier === 'cmd') {
      if (!event.metaKey) {
        return false;
      }
    }
  }

  // Ensure no extra modifiers are pressed (unless they're specified)
  const hasCtrl = modifiers.some((m) => m.toLowerCase() === 'ctrl' || (m.toLowerCase() === 'mod' && !isMac()));
  const hasMeta = modifiers.some((m) => m.toLowerCase() === 'meta' || m.toLowerCase() === 'cmd' || (m.toLowerCase() === 'mod' && isMac()));
  const hasAlt = modifiers.some((m) => m.toLowerCase() === 'alt');
  const hasShift = modifiers.some((m) => m.toLowerCase() === 'shift');

  if (event.ctrlKey && !hasCtrl) {
    return false;
  }
  if (event.metaKey && !hasMeta) {
    return false;
  }
  if (event.altKey && !hasAlt) {
    return false;
  }
  if (event.shiftKey && !hasShift) {
    return false;
  }

  return true;
}
