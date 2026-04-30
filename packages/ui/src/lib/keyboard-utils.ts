export function isMac(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function getModifierKey(): 'Cmd' | 'Ctrl' {
  return isMac() ? 'Cmd' : 'Ctrl';
}

export function formatShortcut(keys: readonly string[]): string {
  if (keys.length === 0) {
    return '';
  }

  return keys
    .map((key) => {
      if (key === 'Mod') {
        return getModifierKey();
      }
      return key;
    })
    .join('+');
}

export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: readonly string[]
): boolean {
  if (shortcut.length === 0) {
    return false;
  }

  const modifiers = shortcut.slice(0, -1);
  const key = shortcut[shortcut.length - 1];

  if (!key) {
    return false;
  }

  const eventKey = event.key.toLowerCase();
  const targetKey = key.toLowerCase();

  if (eventKey !== targetKey) {
    return false;
  }

  for (const modifier of modifiers) {
    const normalizedModifier = modifier.toLowerCase();

    if (normalizedModifier === 'mod') {
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
