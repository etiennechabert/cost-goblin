import { describe, it, expect } from 'vitest';
import { matchesShortcut, formatShortcutLabel } from '../hooks/use-keyboard-shortcuts.js';
import type { Shortcut } from '../hooks/use-keyboard-shortcuts.js';

function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: '', metaKey: false, ctrlKey: false, ...overrides } as unknown as KeyboardEvent;
}

const noop = () => undefined;

describe('matchesShortcut', () => {
  it('matches a simple key', () => {
    const shortcut: Shortcut = { key: 'k', label: 'test', action: noop };
    expect(matchesShortcut(makeKeyEvent({ key: 'k' }), shortcut)).toBe(true);
  });

  it('is case-insensitive', () => {
    const shortcut: Shortcut = { key: 'K', label: 'test', action: noop };
    expect(matchesShortcut(makeKeyEvent({ key: 'k' }), shortcut)).toBe(true);
  });

  it('rejects wrong key', () => {
    const shortcut: Shortcut = { key: 'k', label: 'test', action: noop };
    expect(matchesShortcut(makeKeyEvent({ key: 'j' }), shortcut)).toBe(false);
  });

  it('requires metaKey when specified', () => {
    const shortcut: Shortcut = { key: 'k', metaKey: true, label: 'test', action: noop };
    expect(matchesShortcut(makeKeyEvent({ key: 'k', metaKey: false }), shortcut)).toBe(false);
    expect(matchesShortcut(makeKeyEvent({ key: 'k', metaKey: true }), shortcut)).toBe(true);
  });

  it('requires ctrlKey when specified', () => {
    const shortcut: Shortcut = { key: 'k', ctrlKey: true, label: 'test', action: noop };
    expect(matchesShortcut(makeKeyEvent({ key: 'k', ctrlKey: false }), shortcut)).toBe(false);
    expect(matchesShortcut(makeKeyEvent({ key: 'k', ctrlKey: true }), shortcut)).toBe(true);
  });

  it('matches when modifier not required and present', () => {
    const shortcut: Shortcut = { key: 'k', label: 'test', action: noop };
    expect(matchesShortcut(makeKeyEvent({ key: 'k', metaKey: true }), shortcut)).toBe(true);
  });
});

describe('formatShortcutLabel', () => {
  it('formats meta + key', () => {
    expect(formatShortcutLabel({ key: 'k', metaKey: true, label: '', action: noop })).toBe('\u2318K');
  });

  it('formats ctrl + key', () => {
    expect(formatShortcutLabel({ key: 'k', ctrlKey: true, label: '', action: noop })).toBe('CtrlK');
  });

  it('formats plain key', () => {
    expect(formatShortcutLabel({ key: '1', label: '', action: noop })).toBe('1');
  });

  it('uppercases the key', () => {
    expect(formatShortcutLabel({ key: 'a', label: '', action: noop })).toBe('A');
  });
});
