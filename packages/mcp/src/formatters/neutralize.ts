import { homedir } from 'node:os';

/**
 * Output neutralization for MCP tool results (#602).
 *
 * Tool results carry values that anyone who can tag a cloud resource or edit a
 * shared config file can author. In markdown and csv output a raw `|` adds a
 * table cell and a raw line break ends the table, so what follows would read
 * as CostGoblin's own prose. These helpers keep such values inside their cell
 * or line. They restore STRUCTURE only: a delimiter-free payload still reaches
 * the model verbatim, so this is not prompt-injection protection.
 *
 * Source rule: never write a raw U+0085, U+2028 or U+2029 in this package —
 * compare char codes instead (a raw U+2028 in a regex literal breaks the build).
 */

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const DEL = 0x7f;
const NEL = 0x85;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

/** A line break, written as a backslash followed by `n`. */
const ESCAPED_BREAK = '\\n';

function isLineBreak(code: number): boolean {
  return code === LF || code === CR || code === NEL || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
}

/** What one UTF-16 unit becomes, or undefined when it is kept as-is. */
function replacementFor(code: number): string | undefined {
  if (isLineBreak(code)) return ESCAPED_BREAK;
  if (code === TAB) return ' ';
  if (code < SPACE || code === DEL) return `\\u${code.toString(16).padStart(4, '0')}`;
  return undefined;
}

/**
 * Put `s` on one physical line: every line break (LF, CR, CRLF as one,
 * U+0085, U+2028, U+2029) becomes a backslash followed by `n`, a tab becomes a
 * space, and any other C0 control or DEL becomes a backslash-u escape. Returns
 * `s` itself when nothing needs replacing (the hot path: CSV output can hold
 * hundreds of thousands of lines).
 */
export function toSingleLine(s: string): string {
  let out = '';
  // Start of the run of kept characters not yet copied into `out`.
  let runStart = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const replacement = replacementFor(code);
    if (replacement === undefined) continue;
    out += s.slice(runStart, i) + replacement;
    if (code === CR && s.charCodeAt(i + 1) === LF) i++;
    runStart = i + 1;
  }
  return runStart === 0 ? s : out + s.slice(runStart);
}

/**
 * Make `s` safe as one GFM table cell (header or body): single line, and every
 * `|` escaped as a backslash-pipe. Backslashes are deliberately NOT doubled:
 * GFM treats any backslash-preceded `|` as escaped, and every structural pipe
 * markdownTable emits follows a space, so a trailing backslash cannot escape it.
 */
export function escapeMarkdownCell(s: string): string {
  return toSingleLine(s).replaceAll('|', '\\|');
}

function isBoundaryAfterHome(ch: string): boolean {
  return ch === '' || ch === '/' || ch === '\\' || ch === "'" || ch === '"';
}

function redactOne(message: string, home: string): string {
  let out = '';
  let from = 0;
  for (let at = message.indexOf(home); at !== -1; at = message.indexOf(home, from)) {
    const end = at + home.length;
    out += message.slice(from, at) + (isBoundaryAfterHome(message.charAt(end)) ? '~' : home);
    from = end;
  }
  return from === 0 ? message : out + message.slice(from);
}

/**
 * Replace the user's home directory with `~` wherever it is followed by a path
 * separator, a quote or the end of the message (so `/home/eveline` is left
 * alone for home `/home/eve`). The forward-slash spelling of a Windows home
 * (`C:/Users/eve`, as DuckDB prints paths) is redacted too. No-op when the home
 * directory is empty or `/`.
 */
export function redactHome(message: string, home: string = homedir()): string {
  if (home === '' || home === '/') return message;
  const redacted = redactOne(message, home);
  const forwardSlashHome = home.replaceAll('\\', '/');
  return forwardSlashHome === home ? redacted : redactOne(redacted, forwardSlashHome);
}
