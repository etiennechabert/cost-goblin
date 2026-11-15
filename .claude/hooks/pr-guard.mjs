// Claude Code PreToolUse hook. It holds a session to CLAUDE.md's "After
// pushing — close the review loop" at the two places where the session runs
// `gh` itself:
//
// - `gh pr create` without `--draft` is refused. A PR opens as a draft, so
//   Sentry and Gitar, which both skip drafts, first read code the local
//   review has already fixed.
// - `gh pr ready` is refused until the PR has a comment that opens with
//   "`/code-review xhigh --fix` ran". That comment is what shows the review
//   happened.
//
// It is a guard against forgetting, not a security boundary. It reads the
// command the Bash tool is about to run, so it sees neither a PR opened
// through `gh api`, a `gh` alias or the GitHub UI, nor anything typed in a
// terminal: the maintainer can always run either command by hand.
//
// It guards this repository's pull requests only. A command that `cd`s into
// the checkout of another repository, or names another one (`-R`, `GH_REPO`,
// a pull request URL), is none of its business.
//
// Whenever it can't tell what a command does (a command line it can't read,
// a flag that comes out of a variable, GitHub not answering) it lets the
// command through. A hook that blocks work it has misread costs more than
// one that misses a case, and a pass here only means the normal permission
// flow decides: the hook never approves anything. One case is refused all the
// same: a command with more `gh pr ready` calls than the hook has time to
// check, because that command can be split.
//
// It runs before the command has been approved, so nothing in the command
// line decides what the hook itself executes: `gh` and `git` are started
// with the hook's own environment, never with one the command sets.
//
// Wired in .claude/settings.json; pinned by scripts/ci/pr-guard.test.mjs.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit as defaultRunGit, readStdin, slugOf, startedDirectly } from './shared.mjs';

/**
 * What the comment `gh pr ready` waits for opens with (CLAUDE.md, "After
 * pushing", step 1). `max` counts too: the maintainer sometimes asks for
 * that level, and it is no lighter than `xhigh`.
 */
export const REVIEW_COMMENT = /^\s*`?\/code-review (?:xhigh|max) --fix`? ran\b/;

/**
 * What one run may spend asking GitHub, shared by its `gh pr ready` calls.
 * With the git lookups it stays under the hook's timeout in
 * .claude/settings.json: a hook that is killed lets the command through
 * without the note that says it went unchecked.
 */
export const GH_BUDGET_MS = 15_000;
/** No lookup is started with less than this left: it would time out, and pass for unchecked. */
export const GH_MIN_CALL_MS = 2_000;
/** Above spawnSync's 1 MB default: a long-lived PR carries more than that in bot comments. */
const GH_MAX_OUTPUT = 64 * 1024 * 1024;
/** A directory of the repository this hook guards: its own. */
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

export const CREATE_MESSAGE = [
  'Blocked by .claude/hooks/pr-guard.mjs: `gh pr create` needs `--draft`.',
  'A PR in this repository opens as a draft and turns ready only after `/code-review xhigh --fix` has run on it (CLAUDE.md, "After pushing — close the review loop").',
  'Run the same command again with `--draft`.',
  'If the user asked for a PR that is ready at once, tell them to run the command themselves: this hook only sees the commands you run.',
].join(' ');

export const readyMessage = (number) =>
  [
    `Blocked by .claude/hooks/pr-guard.mjs: PR #${number} has no comment that opens with "\`/code-review xhigh --fix\` ran", so it stays a draft (CLAUDE.md, "After pushing", step 1).`,
    'Run the review, push its fixes and post that comment. Then run `gh pr ready` in a command of its own: this check reads GitHub before the command starts, so it cannot see a comment that the same command posts.',
    'If the user wants the PR ready without the review, tell them to run `gh pr ready` themselves.',
  ].join(' ');

/** For a `gh pr ready` on a PR that is not on GitHub: one the same command opens, or one that does not exist. */
export const missingMessage = (ghSaid) =>
  [
    `Blocked by .claude/hooks/pr-guard.mjs: \`gh pr ready\` targets a pull request GitHub does not have (gh: ${ghSaid}).`,
    'If this command opens it, it has not been through `/code-review xhigh --fix`: open it as a draft, run the review, push its fixes and post the comment that says so (CLAUDE.md, "After pushing", step 1).',
    'Then run `gh pr ready` in a command of its own.',
  ].join(' ');

/** For the `gh pr ready` calls of one command that the hook had no time left to check. */
export const outOfTimeMessage = (unchecked) =>
  [
    `Blocked by .claude/hooks/pr-guard.mjs: this command has more \`gh pr ready\` calls than the hook had time to check with GitHub (${unchecked} left unchecked).`,
    'A PR turns ready only once it has the comment that opens with "`/code-review xhigh --fix` ran" (CLAUDE.md, "After pushing", step 1).',
    'Run the `gh pr ready` calls in commands of their own, a few at a time.',
  ].join(' ');

// ---------------------------------------------------------------------------
// Reading the command line
// ---------------------------------------------------------------------------

/** The command line isn't shell this reader understands: the guard lets it through. */
export class ShellSyntaxError extends Error {}

const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
/** Words that come before a command without being one, as in `if gh pr create …; then`. */
const BEFORE_COMMAND = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=$/;
const VARIABLE = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[?#@*!$-])/;

/**
 * The simple commands a shell command line would run, as
 * `[{ words: [{ text, dynamic, quoted }], cwd }]`.
 *
 * `text` is the word with its quoting removed; `dynamic` says part of it is
 * only known to the shell (a variable, a substitution), and that part is
 * left out of `text`. `cwd` is the directory the command runs in, followed
 * through literal `cd`s, or null once that can't be told.
 *
 * It reads enough shell to know what is a command and what is text: quotes,
 * `$(…)`, backticks, heredocs, comments, redirections, `&&`, `;` and pipes,
 * subshells, and the keywords of `if`, `while` and `for`. That is what keeps
 * a commit message, a heredoc PR body or an `echo` that mention
 * `gh pr create` from being taken for the command, and what finds the
 * command behind `git push && …` or inside `"$(…)"`. Commands inside a
 * substitution are listed before the command whose word holds them.
 *
 * Throws ShellSyntaxError on what it can't read, such as an unclosed quote.
 */
export function readCommands(src, cwd = null) {
  const commands = [];
  const n = src.length;
  let i = 0;
  // Heredocs whose body has not begun. It begins after the next newline the
  // shell reads as one, whichever list that newline is in: for
  // `cat <<EOF && x=$(` the body starts inside the substitution.
  const heredocs = [];

  const fail = (what) => {
    throw new ShellSyntaxError(what);
  };

  const skipBlanks = () => {
    while (src[i] === ' ' || src[i] === '\t') i++;
  };

  /** A literal `cd` moves where the later commands of its list run. */
  function emit(words, scope) {
    commands.push({ words, cwd: scope.cwd });
    // `builtin cd` and `command cd` change directory too
    let at = 0;
    while (at < words.length - 1 && !words[at].dynamic && (words[at].text === 'builtin' || words[at].text === 'command')) at++;
    const name = words[at].dynamic ? null : words[at].text;
    if (name === 'popd') scope.cwd = null;
    if (name !== 'cd' && name !== 'pushd') return;
    const target = words.slice(at + 1).find((w) => w.dynamic || w.text === '-' || !w.text.startsWith('-'));
    if (!target) {
      scope.cwd = name === 'cd' ? homedir() : null;
      return;
    }
    const tilde = !target.quoted && target.text.startsWith('~');
    if (target.dynamic || target.text === '-' || /^[+-]\d+$/.test(target.text) || (tilde && !/^~(?:\/|$)/.test(target.text))) {
      scope.cwd = null;
      return;
    }
    const dir = tilde ? homedir() + target.text.slice(1) : target.text;
    if (isAbsolute(dir)) scope.cwd = resolve(dir);
    else scope.cwd = scope.cwd === null ? null : resolve(scope.cwd, dir);
  }

  /** Commands up to `close`, or to the end of the input when `close` is null. */
  function list(scope, close) {
    let words = [];
    // after `function`, the next word names the function: neither is a command
    let functionName = false;
    const end = () => {
      if (words.length > 0) emit(words, scope);
      words = [];
    };
    for (;;) {
      if (i >= n) {
        if (close) fail(`no closing ${close}`);
        end();
        return;
      }
      const c = src[i];
      if (c === ' ' || c === '\t') {
        i++;
      } else if (c === '\\' && src[i + 1] === '\n') {
        i += 2;
      } else if (c === '\n') {
        i++;
        end();
        for (const heredoc of heredocs.splice(0)) skipHeredoc(heredoc);
      } else if (c === '#') {
        // between words, so this starts a comment
        while (i < n && src[i] !== '\n') i++;
      } else if (c === ')') {
        // ours, or the one that ends a `case` pattern
        i++;
        end();
        if (close === ')') return;
      } else if (c === '&' && src[i + 1] === '>') {
        i += src[i + 2] === '>' ? 3 : 2;
        redirectTarget(scope);
      } else if (c === ';' || c === '&' || c === '|') {
        i++;
        end();
      } else if (c === '(') {
        // a subshell, or the `()` of a function definition
        i++;
        end();
        list({ cwd: scope.cwd }, ')');
      } else if (c === '<' || c === '>') {
        redirect(scope);
      } else {
        const w = word(scope);
        const bare = !w.quoted && !w.dynamic;
        // the descriptor of `2>file` is not an argument
        if (bare && /^\d+$/.test(w.text) && (src[i] === '<' || src[i] === '>')) continue;
        if (words.length === 0 && functionName) {
          functionName = false;
          continue;
        }
        if (bare && words.length === 0 && w.text === 'function') {
          functionName = true;
          continue;
        }
        if (bare && words.length === 0 && BEFORE_COMMAND.has(w.text)) continue;
        words.push(w);
      }
    }
  }

  /** The body of a heredoc is data. It runs from the line after its command to the delimiter. */
  function skipHeredoc({ delimiter, stripTabs }) {
    while (i < n) {
      let lineEnd = src.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = n;
      const line = src.slice(i, lineEnd);
      i = Math.min(lineEnd + 1, n);
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) return;
    }
  }

  function redirect(scope) {
    if (src.startsWith('<<', i) && src[i + 2] !== '<') {
      i += 2;
      const stripTabs = src[i] === '-';
      if (stripTabs) i++;
      skipBlanks();
      const delimiter = WORD_END.has(src[i]) ? '' : word(scope).text;
      if (delimiter === '') fail('heredoc without a delimiter');
      heredocs.push({ delimiter, stripTabs });
      return;
    }
    if (src[i + 1] === '(') {
      // <(…) and >(…) run their commands
      i += 2;
      list({ cwd: scope.cwd }, ')');
      return;
    }
    i += src.startsWith('<<<', i) ? 3 : 1;
    if (src[i] === '>' || src[i] === '&' || src[i] === '|') i++;
    redirectTarget(scope);
  }

  /** What follows a redirection is a file, a descriptor or a here-string: never an argument. */
  function redirectTarget(scope) {
    skipBlanks();
    if (i < n && !WORD_END.has(src[i])) word(scope);
  }

  function word(scope) {
    let text = '';
    let dynamic = false;
    let quoted = false;
    while (i < n) {
      const c = src[i];
      if (WORD_END.has(c)) {
        // `name=(a b)`: the array literal belongs to its assignment and runs nothing
        if (c === '(' && !quoted && ARRAY_ASSIGNMENT.test(text)) {
          skipBalanced('(', ')', true);
          dynamic = true;
          continue;
        }
        break;
      }
      if (c === '\\') {
        if (src[i + 1] !== '\n') {
          text += src[i + 1] ?? '';
          quoted = true;
        }
        i += 2;
      } else if (c === "'") {
        const close = src.indexOf("'", i + 1);
        if (close === -1) fail('no closing quote');
        text += src.slice(i + 1, close);
        i = close + 1;
        quoted = true;
      } else if (c === '"') {
        i++;
        const inner = doubleQuoted(scope);
        text += inner.text;
        dynamic ||= inner.dynamic;
        quoted = true;
      } else if (c === '`') {
        i++;
        backticks(scope);
        dynamic = true;
      } else if (c === '$') {
        const part = dollar(scope, false);
        text += part.text;
        dynamic ||= part.dynamic;
        quoted ||= part.quoted;
      } else {
        text += c;
        i++;
      }
    }
    return { text, dynamic, quoted };
  }

  /** From just after the opening `"` to just after the closing one. */
  function doubleQuoted(scope) {
    let text = '';
    let dynamic = false;
    for (;;) {
      if (i >= n) fail('no closing quote');
      const c = src[i];
      if (c === '"') {
        i++;
        return { text, dynamic };
      }
      if (c === '\\') {
        const next = src[i + 1];
        if (next === '\n') {
          i += 2;
        } else if (next === '$' || next === '`' || next === '"' || next === '\\') {
          text += next;
          i += 2;
        } else {
          text += c;
          i++;
        }
      } else if (c === '`') {
        i++;
        backticks(scope);
        dynamic = true;
      } else if (c === '$') {
        const part = dollar(scope, true);
        text += part.text;
        dynamic ||= part.dynamic;
      } else {
        text += c;
        i++;
      }
    }
  }

  /** At a `$`: a substitution or a variable (dynamic), `$'…'` (literal), or just a dollar sign. */
  function dollar(scope, inDoubleQuotes) {
    const next = src[i + 1];
    if (next === '(') {
      if (src[i + 2] === '(') {
        // $(( arithmetic ))
        i++;
        skipBalanced('(', ')', true);
      } else {
        i += 2;
        list({ cwd: scope.cwd }, ')');
      }
      return { text: '', dynamic: true, quoted: false };
    }
    if (next === '{') {
      i++;
      skipBalanced('{', '}', !inDoubleQuotes);
      return { text: '', dynamic: true, quoted: false };
    }
    if (next === "'" && !inDoubleQuotes) {
      let text = '';
      i += 2;
      for (;;) {
        if (i >= n) fail('no closing quote');
        const c = src[i];
        if (c === "'") {
          i++;
          return { text, dynamic: false, quoted: true };
        }
        if (c === '\\') {
          text += src[i + 1] ?? '';
          i += 2;
        } else {
          text += c;
          i++;
        }
      }
    }
    const name = VARIABLE.exec(src.slice(i + 1, i + 256));
    if (name) {
      i += 1 + name[0].length;
      return { text: '', dynamic: true, quoted: false };
    }
    i++;
    // `$"…"` is a plain double-quoted string; otherwise a dollar sign on its own
    return { text: next === '"' && !inDoubleQuotes ? '' : '$', dynamic: false, quoted: false };
  }

  /** From just after the opening backtick. Its content is a command line of its own. */
  function backticks(scope) {
    let inner = '';
    for (;;) {
      if (i >= n) fail('no closing backtick');
      const c = src[i];
      if (c === '`') {
        i++;
        break;
      }
      if (c === '\\' && (src[i + 1] === '`' || src[i + 1] === '\\' || src[i + 1] === '$')) {
        inner += src[i + 1];
        i += 2;
      } else {
        inner += c;
        i++;
      }
    }
    commands.push(...readCommands(inner, scope.cwd));
  }

  /** From an opening bracket to just after its match. What is inside is not looked at. */
  function skipBalanced(open, close, singleQuotes) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"' || (c === "'" && singleQuotes)) {
        let end = i + 1;
        while (end < n && src[end] !== c) end += c === '"' && src[end] === '\\' ? 2 : 1;
        if (end >= n) fail('no closing quote');
        i = end + 1;
        continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) {
        i++;
        return;
      }
      i++;
    }
    fail(`no closing ${close}`);
  }

  list({ cwd }, null);
  return commands;
}

// ---------------------------------------------------------------------------
// Finding the two `gh` commands
// ---------------------------------------------------------------------------

/** Commands that run the command that follows them. */
const WRAPPERS = new Set(['command', 'env', 'exec', 'nohup', 'noglob', 'time']);
const WRAPPER_VALUE_FLAGS = new Set(['-u', '--unset', '-a', '-C', '--chdir']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** `bash -c 'bash -c "…"'` and deeper is nobody's PR workflow. */
const MAX_NESTING = 3;

/** From `gh pr create --help` (gh 2.96): the flags that take a value, which is never a flag itself. */
const CREATE_VALUE_FLAGS = new Set([
  '--assignee',
  '--base',
  '--body',
  '--body-file',
  '--head',
  '--label',
  '--milestone',
  '--project',
  '--recover',
  '--repo',
  '--reviewer',
  '--template',
  '--title',
]);
const CREATE_VALUE_LETTERS = 'aBbFHlmprRTt';

const plain = (word) => (word && !word.dynamic ? word.text : null);
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
/** The values Go's flag parser reads as true. */
const truthy = (value) => /^(?:1|t|true)$/i.test(value);

/**
 * Every `gh pr create` and `gh pr ready` the command line would run, wherever
 * it sits: after `&&`, in a subshell or a substitution, behind `env` or
 * `command`, in the script of `bash -c` or `eval`.
 */
export function ghPrCalls(src, cwd = null, nesting = 0) {
  const calls = [];
  for (const command of readCommands(src, cwd)) {
    let words = command.words;
    // Of the variables a command sets for itself, only GH_REPO is read: it
    // names the repository, as `-R` does. None is handed to anything the hook
    // runs, which happens before the command has been approved.
    let ghRepo = null;
    const takeAssignments = () => {
      while (words.length > 0 && ASSIGNMENT.test(words[0].text)) {
        const { text, dynamic } = words[0];
        if (text.startsWith('GH_REPO=')) ghRepo = { text: text.slice('GH_REPO='.length), dynamic };
        words = words.slice(1);
      }
    };
    takeAssignments();
    for (let name = plain(words[0]); name !== null && WRAPPERS.has(basename(name)); name = plain(words[0])) {
      words = words.slice(1);
      while (words.length > 0 && !words[0].dynamic && words[0].text.startsWith('-')) {
        words = words.slice(WRAPPER_VALUE_FLAGS.has(words[0].text) ? 2 : 1);
      }
      takeAssignments();
    }
    const name = plain(words[0]);
    if (name === null) continue;
    const program = basename(name);
    const args = words.slice(1);
    if (program === 'gh') {
      const call = ghPrCall(args);
      // gh puts `-R` before GH_REPO; an empty GH_REPO names nothing
      if (call) calls.push({ ...call, repo: call.repo ?? (ghRepo?.dynamic || ghRepo?.text ? ghRepo : null), cwd: command.cwd });
    } else if (nesting < MAX_NESTING && SHELLS.has(program)) {
      const flag = args.findIndex((w) => !w.dynamic && /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
      const script = flag === -1 ? null : plain(args[flag + 1]);
      if (script !== null) calls.push(...ghPrCalls(script, command.cwd, nesting + 1));
    } else if (nesting < MAX_NESTING && program === 'eval' && args.every((w) => !w.dynamic)) {
      calls.push(...ghPrCalls(args.map((w) => w.text).join(' '), command.cwd, nesting + 1));
    }
  }
  return calls;
}

/**
 * A `-R` or `--repo` flag at `words[k]`, as `{ repo, taken }`: the word that
 * names the repository, and how many words the flag takes up. Null for any
 * other word.
 */
function repoFlag(words, k) {
  const { text, dynamic } = words[k];
  if (text === '-R' || text === '--repo') {
    // `-R"$REPO"` carries its value; `-R "$REPO"` has it in the next word
    return dynamic ? { repo: { text: '', dynamic }, taken: 1 } : { repo: words[k + 1] ?? null, taken: 2 };
  }
  if (text.startsWith('--repo=')) return { repo: { text: text.slice('--repo='.length), dynamic }, taken: 1 };
  if (/^-R./.test(text)) return { repo: { text: text.slice(text[2] === '=' ? 3 : 2), dynamic }, taken: 1 };
  return null;
}

/** `gh [flags] pr [flags] create|new|ready …`, or null for any other `gh` command. */
function ghPrCall(args) {
  let repo = null;
  const path = [];
  let k = 0;
  for (; k < args.length && path.length < 2; k++) {
    const flag = repoFlag(args, k);
    if (flag) {
      repo = flag.repo;
      k += flag.taken - 1;
      continue;
    }
    const { text, dynamic } = args[k];
    // which command runs depends on a variable
    if (dynamic) return null;
    if (!text.startsWith('-')) path.push(text);
  }
  if (path[0] !== 'pr') return null;
  const rest = args.slice(k);
  if (path[1] === 'create' || path[1] === 'new') return createCall(rest, repo);
  if (path[1] === 'ready') return readyCall(rest, repo);
  return null;
}

function createCall(rest, repoBefore) {
  let repo = repoBefore;
  let draft = false;
  // --web, --dry-run and --help open no PR from here
  let exempt = false;
  // a flag comes out of a variable, and could be --draft
  let unsure = false;
  for (let k = 0; k < rest.length; k++) {
    const { text, dynamic } = rest[k];
    if (text === '--' && !dynamic) break;
    if (text.startsWith('--')) {
      const flag = repoFlag(rest, k);
      if (flag) {
        repo = flag.repo;
        k += flag.taken - 1;
        continue;
      }
      const eq = text.indexOf('=');
      const name = eq === -1 ? text : text.slice(0, eq);
      if (eq === -1 && dynamic) unsure = true;
      else if (name === '--draft') {
        if (eq === -1) draft = true;
        else if (dynamic) unsure = true;
        else draft = truthy(text.slice(eq + 1));
      } else if (name === '--web' || name === '--dry-run' || name === '--help') {
        // `--web=false` opens the PR from here after all
        if (eq === -1 || dynamic || truthy(text.slice(eq + 1))) exempt = true;
      } else if (eq === -1 && CREATE_VALUE_FLAGS.has(name)) k++;
    } else if (text.startsWith('-') && text.length > 1) {
      // A cluster such as -fd, read as gh reads it. A letter that takes a
      // value ends it, and so does `=`: `-d=false` gives the flag its value.
      for (let c = 1; c < text.length; c++) {
        const letter = text[c];
        const given = text[c + 1] === '=' ? { text: text.slice(c + 2), dynamic } : null;
        if (CREATE_VALUE_LETTERS.includes(letter)) {
          const attached = given ?? (c < text.length - 1 ? { text: text.slice(c + 1), dynamic } : null);
          // `-t "$TITLE"` has its value in the next word; `-t"$TITLE"` carries it
          const value = attached ?? (dynamic ? { text: '', dynamic } : (rest[++k] ?? null));
          if (letter === 'R') repo = value;
          break;
        }
        if (letter === 'd') {
          if (given?.dynamic) unsure = true;
          else draft = given ? truthy(given.text) : true;
        } else if (letter === 'w' || letter === 'h') {
          if (!given || given.dynamic || truthy(given.text)) exempt = true;
        }
        if (given) break;
      }
    } else if (dynamic) {
      unsure = true;
    }
  }
  return { kind: 'create', draft, exempt, unsure, repo };
}

function readyCall(rest, repoBefore) {
  let repo = repoBefore;
  let undo = false;
  let exempt = false;
  let selector = null;
  for (let k = 0; k < rest.length; k++) {
    const flag = repoFlag(rest, k);
    if (flag) {
      repo = flag.repo;
      k += flag.taken - 1;
      continue;
    }
    const word = rest[k];
    const { text, dynamic } = word;
    if (text === '--undo') undo = true;
    else if (text.startsWith('--undo=')) undo = dynamic || truthy(text.slice('--undo='.length));
    else if (!dynamic && (text === '--help' || text === '-h')) exempt = true;
    else if (dynamic || !text.startsWith('-')) selector ??= word;
  }
  return { kind: 'ready', undo, exempt, selector, repo };
}

// ---------------------------------------------------------------------------
// Whose pull request
// ---------------------------------------------------------------------------

const PR_URL = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/;

/** The repository a call names, which gh puts before the one of its directory: a pull request URL, then `-R` or `GH_REPO`. */
function namedRepository({ kind, selector, repo }) {
  const url = kind === 'ready' && selector && !selector.dynamic ? PR_URL.exec(selector.text) : null;
  if (url) return `${url[1]}/${url[2]}`.toLowerCase();
  return repo && !repo.dynamic ? slugOf(repo.text) : null;
}

/**
 * A test for the calls that are about another repository than this one.
 *
 * A call that names a repository is compared with this checkout's `origin`.
 * Any other call is about the repository of the directory it runs in, and
 * that is this one when both have the same `.git` directory, which every
 * worktree of a clone shares. When it can't tell (a directory it could not
 * follow or that is no repository, a checkout without `origin`), the call is
 * taken to be about this repository: that is what a session here works on.
 */
function otherRepository(runGit, here) {
  const once = (read) => {
    let value;
    return () => (value === undefined ? (value = read()) : value);
  };
  // one lookup per directory, however many calls of the command run there
  const gitDirs = new Map();
  const gitDirOf = (dir) => {
    if (!gitDirs.has(dir)) gitDirs.set(dir, runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    return gitDirs.get(dir);
  };
  const ourGitDir = () => gitDirOf(here);
  const ourOrigin = once(() => {
    const url = runGit(here, ['config', '--get', 'remote.origin.url']);
    return url === null ? null : slugOf(url);
  });
  return (call) => {
    const named = namedRepository(call);
    if (named !== null) return ourOrigin() !== null && named !== ourOrigin();
    if (call.cwd === null) return false;
    const theirGitDir = gitDirOf(call.cwd);
    return theirGitDir !== null && ourGitDir() !== null && theirGitDir !== ourGitDir();
  };
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/**
 * Runs in the hook's own environment: nothing the command line sets for
 * itself (PATH, a library to preload) reaches it.
 */
function defaultRunGh(args, { cwd, timeout }) {
  const result = spawnSync('gh', args, {
    cwd,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout,
    maxBuffer: GH_MAX_OUTPUT,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const firstLine = (text) => (typeof text === 'string' ? text.trim().split('\n')[0] : '');
/** What gh says of a PR that is not there: by branch, then by number. */
const NO_SUCH_PR = /no (?:open )?pull requests found|Could not resolve to a PullRequest/i;

/**
 * `{}` when the PR has the review comment, `{ deny }` when it doesn't or is
 * not on GitHub at all, `{ note }` when that couldn't be read.
 */
function checkReady(call, runGh, timeout) {
  const { selector, repo, cwd } = call;
  const unchecked = (why) => ({ note: `pr-guard did not check \`gh pr ready\`: ${why}.` });
  if (selector?.dynamic || repo?.dynamic) return unchecked('the pull request it targets comes out of a variable');
  const anywhere = selector !== null && (repo !== null || /^https?:\/\//.test(selector.text));
  if (cwd === null && !anywhere) return unchecked('the directory it runs in could not be followed');
  const args = ['pr', 'view'];
  if (selector) args.push(selector.text);
  if (repo) args.push('--repo', repo.text);
  args.push('--json', 'number,comments');
  let pr;
  try {
    const result = runGh(args, { cwd: cwd ?? undefined, timeout });
    if (result.status !== 0) {
      const said = firstLine(result.stderr) || `exit ${result.status}`;
      // No such PR is an answer, not a failure to ask: the PR this command
      // would turn ready is one it opens itself, so nothing has reviewed it.
      if (NO_SUCH_PR.test(said)) return { deny: missingMessage(said) };
      return unchecked(`gh could not read the pull request (${said})`);
    }
    pr = JSON.parse(result.stdout);
  } catch (error) {
    return unchecked(`gh could not read the pull request (${error instanceof Error ? error.message : String(error)})`);
  }
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  if (comments.some((comment) => typeof comment?.body === 'string' && REVIEW_COMMENT.test(comment.body))) return {};
  return { deny: readyMessage(pr?.number ?? '?') };
}

/**
 * What the hook answers for one PreToolUse input: `{ deny }` to refuse the
 * command, `{ note }` when a `gh pr ready` could not be checked, `{}` to say
 * nothing. The tests inject `runGh` and `runGit`, the clock, and `here`, a
 * directory of the repository being guarded.
 */
export function decide(input, { runGh = defaultRunGh, runGit = defaultRunGit, here = HOOK_DIR, now = Date.now } = {}) {
  const command = input?.tool_name === 'Bash' ? input.tool_input?.command : null;
  if (typeof command !== 'string' || !command.includes('gh')) return {};
  let calls;
  try {
    calls = ghPrCalls(command, typeof input.cwd === 'string' ? input.cwd : process.cwd());
  } catch (error) {
    if (error instanceof ShellSyntaxError) return {};
    throw error;
  }
  // the calls with something to check: a create that opens a ready PR, a ready that is not an undo
  const checked = calls.filter((call) =>
    call.kind === 'create' ? !call.draft && !call.exempt && !call.unsure : !call.undo && !call.exempt,
  );
  if (checked.length === 0) return {};
  const elsewhere = otherRepository(runGit, here);
  const ours = checked.filter((call) => !elsewhere(call));
  if (ours.some((call) => call.kind === 'create')) return { deny: CREATE_MESSAGE };
  // Each lookup may use what is left of the budget. Once too little is left
  // the remaining calls are refused: letting them through unread would turn a
  // long list of `gh pr ready` into a way past the check. The first call
  // always has the whole budget, so one `gh pr ready` is never refused for time.
  const deadline = now() + GH_BUDGET_MS;
  const notes = [];
  for (const [index, call] of ours.entries()) {
    const left = deadline - now();
    if (left < GH_MIN_CALL_MS) return { deny: outOfTimeMessage(ours.length - index) };
    const { deny, note } = checkReady(call, runGh, left);
    if (deny) return { deny };
    if (note) notes.push(note);
  }
  return notes.length > 0 ? { note: notes.join(' ') } : {};
}

// ---------------------------------------------------------------------------
// The hook itself
// ---------------------------------------------------------------------------

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // not a hook call: nothing to guard
    return;
  }
  let outcome;
  try {
    outcome = decide(input);
  } catch (error) {
    // a bug here must not stop work: say so, and let the command through
    outcome = { note: `pr-guard failed and checked nothing: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (outcome.deny) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: outcome.deny,
        },
      }),
    );
  } else if (outcome.note) {
    // No decision: the command goes on to the normal permission flow. The note
    // reaches the user (systemMessage) and Claude (additionalContext), so a
    // `gh pr ready` that went unchecked is not taken for one that passed.
    process.stdout.write(
      JSON.stringify({
        systemMessage: outcome.note,
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: outcome.note },
      }),
    );
  }
}

if (startedDirectly(import.meta.url)) await main();
