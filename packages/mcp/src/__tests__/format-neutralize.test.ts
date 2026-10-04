import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { escapeMarkdownCell, redactHome, toSingleLine } from '../formatters/neutralize.js';
import { toolError } from '../tools/tool-helpers.js';
import { BREAKS, ESCAPED_BREAK, splitPhysicalLines } from './helpers/lines.js';

describe('toSingleLine', () => {
  it.each(BREAKS)('turns a %s break into one backslash-n', (_name, br) => {
    expect(toSingleLine(`a${br}b`)).toBe(`a${ESCAPED_BREAK}b`);
  });

  it('keeps consecutive breaks distinct (CRLF CRLF is two, LF CR is two)', () => {
    expect(toSingleLine('a\r\n\r\nb')).toBe(`a${ESCAPED_BREAK}${ESCAPED_BREAK}b`);
    expect(toSingleLine('a\n\rb')).toBe(`a${ESCAPED_BREAK}${ESCAPED_BREAK}b`);
  });

  it('handles breaks at the very start and end', () => {
    expect(toSingleLine('\nmid\r')).toBe(`${ESCAPED_BREAK}mid${ESCAPED_BREAK}`);
    expect(toSingleLine('\r\n')).toBe(ESCAPED_BREAK);
  });

  it('turns a tab into a space', () => {
    expect(toSingleLine('a\tb')).toBe('a b');
  });

  it.each([
    ['NUL', 0x00, '\\u0000'],
    ['BEL', 0x07, '\\u0007'],
    ['ESC', 0x1b, '\\u001b'],
    ['US', 0x1f, '\\u001f'],
    ['DEL', 0x7f, '\\u007f'],
  ])('escapes %s as backslash-u plus 4 hex digits', (_name, code, expected) => {
    expect(toSingleLine(`x${String.fromCharCode(code)}y`)).toBe(`x${expected}y`);
  });

  it.each([
    ['accented letters', 'café résumé'],
    ['an emoji (surrogate pair)', 'cost \u{1F4B8} spike'],
    ['a no-break space', `a${String.fromCharCode(0xa0)}b`],
    ['backslashes', 'C:\\temp\\n not a break'],
    ['a pipe', 'a | b'],
    ['the empty string', ''],
  ])('leaves %s unchanged', (_name, value) => {
    expect(toSingleLine(value)).toBe(value);
  });

  it('never leaves a physical line break behind', () => {
    const all = BREAKS.map(([, br]) => `v${br}`).join('');
    expect(splitPhysicalLines(toSingleLine(all))).toHaveLength(1);
  });
});

describe('escapeMarkdownCell', () => {
  it('escapes a pipe with a backslash', () => {
    expect(escapeMarkdownCell('bob | x')).toBe('bob \\| x');
  });

  it('flattens breaks and escapes pipes together', () => {
    expect(escapeMarkdownCell('a\nb|c')).toBe(`a${ESCAPED_BREAK}b\\|c`);
  });

  it('does not double existing backslashes', () => {
    expect(escapeMarkdownCell('back\\|slash')).toBe('back\\\\|slash');
    expect(escapeMarkdownCell('trailing\\')).toBe('trailing\\');
  });
});

describe('redactHome', () => {
  it.each([
    ['a path separator', '/home/eve/data/x.parquet', '~/data/x.parquet'],
    ['a Windows separator', '/home/eve\\data', '~\\data'],
    ['a single quote', "open '/home/eve' failed", "open '~' failed"],
    ['a double quote', 'open "/home/eve" failed', 'open "~" failed'],
    ['the end of the message', 'cwd is /home/eve', 'cwd is ~'],
    // The usual error-message terminators after a bare path.
    ['a colon', 'Cannot open /home/eve: Permission denied', 'Cannot open ~: Permission denied'],
    ['a space', 'dir /home/eve is not writable', 'dir ~ is not writable'],
    ['a closing paren', 'in (/home/eve)', 'in (~)'],
    ['a comma', 'tried /home/eve, then /tmp', 'tried ~, then /tmp'],
    ['a sentence-ending dot', 'No such directory /home/eve.', 'No such directory ~.'],
    ['a newline', 'path: /home/eve\nnext', 'path: ~\nnext'],
    ['a backtick', 'open `/home/eve` failed', 'open `~` failed'],
  ])('redacts the home directory followed by %s', (_name, message, expected) => {
    expect(redactHome(message, '/home/eve')).toBe(expected);
  });

  it('redacts every occurrence', () => {
    expect(redactHome('/home/eve/a and /home/eve/b', '/home/eve')).toBe('~/a and ~/b');
  });

  it('leaves a longer name that merely starts with the home directory', () => {
    expect(redactHome('/home/eveline/x', '/home/eve')).toBe('/home/eveline/x');
    expect(redactHome('/home/eve.bak/x', '/home/eve')).toBe('/home/eve.bak/x');
    expect(redactHome('/home/eve-old/x', '/home/eve')).toBe('/home/eve-old/x');
    expect(redactHome('/home/evé/x', '/home/eve')).toBe('/home/evé/x');
    expect(redactHome('/Users/evé/x', '/Users/eve')).toBe('/Users/evé/x');
  });

  it('matches a Windows home directory case-insensitively', () => {
    expect(redactHome('IO Error: c:\\users\\eve\\data', 'C:\\Users\\Eve', 'win32')).toBe('IO Error: ~\\data');
    expect(redactHome('IO Error: C:/USERS/EVE/data', 'C:\\Users\\Eve', 'win32')).toBe('IO Error: ~/data');
    expect(redactHome('/home/EVE/x', '/home/eve', 'linux')).toBe('/home/EVE/x');
  });

  it('redacts the forward-slash form of a Windows home directory', () => {
    expect(redactHome('IO Error: C:/Users/eve/data/x.parquet', 'C:\\Users\\eve')).toBe('IO Error: ~/data/x.parquet');
    expect(redactHome('IO Error: C:\\Users\\eve\\data', 'C:\\Users\\eve')).toBe('IO Error: ~\\data');
  });

  it.each([['empty', ''], ['root', '/']])('does nothing when the home directory is %s', (_name, home) => {
    expect(redactHome('/etc/passwd', home)).toBe('/etc/passwd');
  });
});

describe('toolError', () => {
  function text(result: ReturnType<typeof toolError>): string {
    return result.content[0].text;
  }

  it('is a single line whatever breaks the message holds', () => {
    const message = BREAKS.map(([name, br]) => `${name}${br}## Forged`).join('');
    const result = toolError(message);
    expect(result.isError).toBe(true);
    expect(splitPhysicalLines(text(result))).toHaveLength(1);
    expect(text(result).startsWith('Error: ')).toBe(true);
  });

  it('redacts the home directory', () => {
    const out = text(toolError(`IO Error: No files found that match the pattern "${homedir()}/x"`));
    expect(out).toContain('"~/x"');
    expect(out).not.toContain(homedir());
  });
});
