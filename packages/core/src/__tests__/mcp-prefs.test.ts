import { describe, it, expect } from 'vitest';
import { MCP_PREFERENCES_DEFAULTS, parseMcpPreferences } from '../mcp/index.js';

describe('parseMcpPreferences', () => {
  it('defaults to off', () => {
    expect(MCP_PREFERENCES_DEFAULTS).toStrictEqual({ enabled: false });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'true'],
    ['an empty object', {}],
    ['a string flag', { enabled: 'true' }],
    ['a numeric flag', { enabled: 1 }],
  ])('fails closed for %s', (_label, raw) => {
    expect(parseMcpPreferences(raw)).toStrictEqual({ enabled: false });
  });

  it('is on only for a literal true', () => {
    expect(parseMcpPreferences({ enabled: true })).toStrictEqual({ enabled: true });
  });

  it('ignores unknown fields', () => {
    expect(parseMcpPreferences({ enabled: true, port: 1 })).toStrictEqual({ enabled: true });
  });
});
