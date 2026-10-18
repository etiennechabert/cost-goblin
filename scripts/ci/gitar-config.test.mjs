// Keeps Gitar's configuration (.gitar/) honest.
//
// Gitar, the AI reviewer on every pull request, loads .gitar/review/ and
// .gitar/instructions/ into each run and acts on the rules and skills beside
// them. Guidance that names a file or helper which has since moved sends the
// reviewer after code that isn't there, and nothing else would notice the
// drift. So every repository path those files quote in backticks must still
// exist, every code identifier they quote must still appear in some code or
// config file (a mention in a comment counts, so this catches renames, not
// every stale reference), rules and skills must carry the frontmatter Gitar
// reads, and the always-loaded files stay under a size budget: Gitar's docs say
// review instructions are paid for on every run.
//
// Each checker is a pure function, self-tested on inline input first, so a
// checker that silently matches nothing can't make the real assertions pass
// vacuously.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);

/**
 * Bytes of .gitar/review/ plus .gitar/instructions/ that every run loads. It
 * keeps a few KB free for the lessons CLAUDE.md asks each PR to record: at
 * 28 KB the guides were full, and lessons were dropped or moved to CLAUDE.md.
 */
const ALWAYS_LOADED_BUDGET = 32_000;

/** Files whose contents can define an identifier the guidance quotes. */
const CODE_FILE = /\.(ts|tsx|mts|js|mjs|cjs|json|ya?ml|sh)$/;

/** Names the guidance quotes on purpose that no repo file defines (banned or third-party APIs). */
const EXTERNAL_NAMES = new Set(['localStorage', 'senderFrame']);

// ---------------------------------------------------------------- checkers

/** Inline code spans outside fenced code blocks, with the line each is on. */
export function codeSpans(markdown) {
  const spans = [];
  let fenced = false;
  markdown.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const match of line.matchAll(/`([^`]+)`/g)) spans.push({ text: match[1], line: i + 1 });
  });
  return spans;
}

/**
 * The repository path a span names, or null. A span is a path when it has no
 * spaces and its first segment is an existing top-level entry (`CLAUDE.md`,
 * `packages/…`, `.github/…`), so `raw/{tier}-{YYYY-MM}/` and `fix(ui): …` aren't.
 */
export function asRepoPath(span, topLevel) {
  if (/\s/.test(span)) return null;
  const first = span.split('/')[0];
  if (!topLevel.has(first)) return null;
  if (!span.includes('/') && !/\.[A-Za-z]+$/.test(span)) return null;
  return span;
}

/**
 * The paths a span could name relative to the `.gitar/` file quoting it: a
 * sibling (`sync-and-config.md`) or a `.gitar/` entry (`config/risk.md`,
 * `instructions/`). Null when the span looks like neither, so
 * `raw/{tier}-{YYYY-MM}/` isn't taken for a path.
 */
export function relativeCandidates(span, quotingFile, gitarEntries) {
  if (/\s/.test(span)) return null;
  if (!span.endsWith('.md') && !gitarEntries.has(span.split('/')[0])) return null;
  const dir = quotingFile.slice(0, quotingFile.lastIndexOf('/') + 1);
  return [`${dir}${span}`, `.gitar/${span}`];
}

/** Whether `path` (a file, a directory ending in /, or a glob) matches one of `files`. */
export function pathExists(path, files) {
  if (/[*{<]/.test(path)) {
    const pattern = path
      .replace(/[.+^$()|[\]\\]/g, '\\$&')
      .replace(/<[^>]+>/g, '[^/]+')
      .replace(/\*\*\//g, '(?:.+/)?')
      .replace(/\*/g, '[^/]*')
      .replace(/\{([^}]+)\}/g, (_, alts) => `(?:${alts.split(',').join('|')})`);
    const re = new RegExp(`^${pattern}${path.endsWith('/') ? '' : '(?:/|$)'}`);
    return files.some((f) => re.test(f));
  }
  const dir = path.endsWith('/') ? path : `${path}/`;
  return files.some((f) => f === path || f.startsWith(dir));
}

/** The code identifier a span names (camelCase or PascalCase, optional `()`), or null. */
export function asIdentifier(span) {
  const match = /^([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)(?:\(\))?$/.exec(span);
  return match ? match[1] : null;
}

/**
 * The YAML frontmatter of a markdown file, or null when it has none. CRLF is
 * accepted: a Windows checkout with core.autocrlf rewrites these files.
 */
export function frontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  return match ? (parse(match[1]) ?? {}) : null;
}

/** Problems with a `.gitar/rules/*.md` rule, per docs.gitar.ai/features/rules. */
export function ruleProblems(markdown) {
  const fm = frontmatter(markdown);
  if (!fm) return ['has no frontmatter'];
  const problems = ['title', 'description', 'when', 'actions']
    .filter((key) => typeof fm[key] !== 'string' || fm[key].trim() === '')
    .map((key) => `frontmatter lacks \`${key}\``);
  if (fm.type !== undefined && fm.type !== 'check' && fm.type !== 'automation') {
    problems.push(`type must be check or automation, not ${String(fm.type)}`);
  }
  return problems;
}

/** Problems with a SKILL.md, per docs.gitar.ai/integrations/skills. */
export function skillProblems(markdown) {
  const fm = frontmatter(markdown);
  if (!fm) return ['has no frontmatter'];
  const problems = [];
  if (typeof fm.name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) {
    problems.push('name must be kebab-case');
  }
  if (typeof fm.description !== 'string' || fm.description.trim() === '') {
    problems.push('frontmatter lacks `description`');
  }
  return problems;
}

// ---------------------------------------------------------------- self-tests

describe('gitar config checkers (self-test on inline input)', () => {
  const files = ['CLAUDE.md', 'packages/ui/src/api/CostApi.ts', 'e2e/views-core.test.ts', 'scripts/ci/a.test.mjs'];
  const topLevel = new Set(['CLAUDE.md', 'packages', 'e2e', 'scripts']);

  it('reads inline spans but skips fenced code', () => {
    const spans = codeSpans('see `a/b`\n```\n`not/this`\n```\nand `c`');
    expect(spans).toEqual([
      { text: 'a/b', line: 1 },
      { text: 'c', line: 5 },
    ]);
  });

  it('treats only spans rooted at an existing top-level entry as paths', () => {
    expect(asRepoPath('packages/ui/src/api/CostApi.ts', topLevel)).toBe('packages/ui/src/api/CostApi.ts');
    expect(asRepoPath('CLAUDE.md', topLevel)).toBe('CLAUDE.md');
    expect(asRepoPath('raw/{tier}-{YYYY-MM}/', topLevel)).toBeNull();
    expect(asRepoPath('npm run build --workspace=packages/desktop', topLevel)).toBeNull();
    expect(asRepoPath('packages', topLevel)).toBeNull();
  });

  it('resolves sibling and .gitar/-relative spans, and nothing else', () => {
    const entries = new Set(['review', 'config']);
    expect(relativeCandidates('sync-and-config.md', '.gitar/review/focus.md', entries)).toEqual([
      '.gitar/review/sync-and-config.md',
      '.gitar/sync-and-config.md',
    ]);
    expect(relativeCandidates('config/risk.md', '.gitar/README.md', entries)).toEqual([
      '.gitar/config/risk.md',
      '.gitar/config/risk.md',
    ]);
    expect(relativeCandidates('raw/{tier}-{YYYY-MM}/', '.gitar/review/a.md', entries)).toBeNull();
    expect(relativeCandidates('fix(ui): …', '.gitar/review/a.md', entries)).toBeNull();
  });

  it('resolves files, directories, globs and <placeholders> against the file list', () => {
    expect(pathExists('packages/ui/src/api/CostApi.ts', files)).toBe(true);
    expect(pathExists('packages/ui/', files)).toBe(true);
    expect(pathExists('packages/*/src/', files)).toBe(true);
    expect(pathExists('scripts/**/*.test.mjs', files)).toBe(true);
    expect(pathExists('e2e/<shard>.test.ts', files)).toBe(true);
    expect(pathExists('packages/ui/src/api/Gone.ts', files)).toBe(false);
    expect(pathExists('packages/core/', files)).toBe(false);
    expect(pathExists('packages/ui/src/api/Cost', files)).toBe(false);
  });

  it('recognizes camelCase and PascalCase identifiers only', () => {
    expect(asIdentifier('parseDimensionsPayload')).toBe('parseDimensionsPayload');
    expect(asIdentifier('firstWindow()')).toBe('firstWindow');
    expect(asIdentifier('CostApi')).toBe('CostApi');
    expect(asIdentifier('esbuild')).toBeNull();
    expect(asIdentifier('ESTRICTALLOWSCRIPTS')).toBeNull();
    expect(asIdentifier('gitar-bot[bot]')).toBeNull();
  });

  it('flags rules and skills without the frontmatter Gitar reads', () => {
    const complete = '---\ntitle: "T"\ndescription: "D"\ntype: check\nwhen: "W"\nactions: "A"\n---\nbody';
    expect(ruleProblems(complete)).toEqual([]);
    expect(ruleProblems('# no frontmatter')).toEqual(['has no frontmatter']);
    expect(ruleProblems('---\ntitle: "T"\ntype: rule\n---\n')).toEqual([
      'frontmatter lacks `description`',
      'frontmatter lacks `when`',
      'frontmatter lacks `actions`',
      'type must be check or automation, not rule',
    ]);
    expect(skillProblems('---\nname: run-desktop\ndescription: "D"\n---\n')).toEqual([]);
    expect(ruleProblems(complete.replaceAll('\n', '\r\n'))).toEqual([]);
    expect(skillProblems('---\nname: Run Desktop\n---\n')).toEqual([
      'name must be kebab-case',
      'frontmatter lacks `description`',
    ]);
  });
});

// ---------------------------------------------------------------- the real config

/**
 * The working tree's files as git sees them: tracked or untracked-but-not-ignored,
 * minus files deleted but not yet staged, so a check run before `git add` matches
 * what is on disk.
 */
function listRepoFiles() {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    const reason = result.error?.message ?? result.stderr;
    throw new Error(`git ls-files failed, and this suite needs a git checkout: ${reason}`);
  }
  // A path in a merge conflict is listed once per stage.
  const paths = new Set(result.stdout.split('\0').filter(Boolean));
  return [...paths].filter((f) => existsSync(new URL(f, repoRoot)));
}

const repoFiles = listRepoFiles();
const read = (path) => readFileSync(new URL(path, repoRoot), 'utf8');
const gitarFiles = repoFiles.filter((f) => f.startsWith('.gitar/') && f.endsWith('.md'));
const topLevel = new Set(repoFiles.map((f) => f.split('/')[0]));
const gitarEntries = new Set(gitarFiles.map((f) => f.split('/')[1]));

describe('gitar config (.gitar/)', () => {
  it('finds the files it polices', () => {
    expect(gitarFiles.some((f) => f.startsWith('.gitar/review/'))).toBe(true);
    expect(gitarFiles.some((f) => f.startsWith('.gitar/rules/'))).toBe(true);
  });

  it('quotes only paths that exist, from the repository root or relative to .gitar/', () => {
    const candidates = (span, file) => {
      const rooted = asRepoPath(span, topLevel);
      return rooted === null ? relativeCandidates(span, file, gitarEntries) : [rooted];
    };
    const missing = gitarFiles.flatMap((file) =>
      codeSpans(read(file))
        .map((span) => ({ ...span, paths: candidates(span.text, file) }))
        .filter(({ paths }) => paths !== null && !paths.some((path) => pathExists(path, repoFiles)))
        .map(({ text, line }) => `${file}:${line} names ${text}`),
    );
    expect(missing).toEqual([]);
  });

  it('quotes only identifiers that still appear in some code or config file', () => {
    const code = repoFiles
      .filter((f) => CODE_FILE.test(f) && !f.startsWith('.gitar/') && !f.endsWith('package-lock.json'))
      .map(read)
      .join('\n');
    const missing = gitarFiles.flatMap((file) =>
      codeSpans(read(file))
        .map((span) => ({ ...span, id: asIdentifier(span.text) }))
        .filter(({ id }) => id !== null && !EXTERNAL_NAMES.has(id) && !new RegExp(`\\b${id}\\b`).test(code))
        .map(({ id, line }) => `${file}:${line} names ${id}`),
    );
    expect(missing).toEqual([]);
  });

  it('gives every rule the frontmatter Gitar reads', () => {
    const problems = gitarFiles
      .filter((f) => f.startsWith('.gitar/rules/'))
      .flatMap((file) => ruleProblems(read(file)).map((p) => `${file}: ${p}`));
    expect(problems).toEqual([]);
  });

  it('gives every skill a kebab-case name and a description', () => {
    const problems = gitarFiles
      .filter((f) => f.endsWith('/SKILL.md'))
      .flatMap((file) => skillProblems(read(file)).map((p) => `${file}: ${p}`));
    expect(problems).toEqual([]);
  });

  it(`keeps the always-loaded guidance under ${ALWAYS_LOADED_BUDGET} bytes`, () => {
    const bytes = gitarFiles
      .filter((f) => f.startsWith('.gitar/review/') || f.startsWith('.gitar/instructions/'))
      .reduce((sum, file) => sum + Buffer.byteLength(read(file)), 0);
    expect(bytes).toBeLessThanOrEqual(ALWAYS_LOADED_BUDGET);
  });
});
