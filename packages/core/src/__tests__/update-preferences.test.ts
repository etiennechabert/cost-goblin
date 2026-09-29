import { describe, it, expect } from 'vitest';
import { UPDATE_PREFERENCES_DEFAULTS, parseUpdatePreferences } from '../updates/index.js';

describe('parseUpdatePreferences', () => {
  it('defaults to checking at startup', () => {
    expect(UPDATE_PREFERENCES_DEFAULTS).toStrictEqual({ checkOnStartup: true });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['an empty object', {}],
    ['a string "false"', { checkOnStartup: 'false' }],
    ['a numeric 0', { checkOnStartup: 0 }],
    ['a null flag', { checkOnStartup: null }],
    ['a literal true', { checkOnStartup: true }],
  ])('keeps the startup check on for %s', (_label, raw) => {
    expect(parseUpdatePreferences(raw)).toStrictEqual({ checkOnStartup: true });
  });

  it('turns the startup check off only for a literal false', () => {
    expect(parseUpdatePreferences({ checkOnStartup: false })).toStrictEqual({ checkOnStartup: false });
  });

  it('ignores unknown fields', () => {
    expect(parseUpdatePreferences({ checkOnStartup: false, channel: 'beta' })).toStrictEqual({ checkOnStartup: false });
  });
});
