// Keeps Gitar's configuration (.gitar/) honest.
//
// Gitar, the AI reviewer on every pull request, loads .gitar/review/ and
// .gitar/instructions/ into each run and acts on the rules and skills beside
// them. Guidance that names a file or helper which has since moved sends the
// reviewer after code that isn't there, and nothing else would notice the
// drift. So every repository path and code identifier those files quote in
// backticks must still exist, rules and skills must carry the frontmatter Gitar
// reads, and the always-loaded files stay under a size budget: Gitar's docs say
// review instructions are paid for on every run.
//
// Each checker is a pure function, self-tested on inline input first, so a
// checker that silently matches nothing can't make the real assertions pass
// vacuously.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);

/** Bytes of .gitar/review/ plus .gitar/instructions/ that every run loads. */
const ALWAYS_LOADED_BUDGET = 24_000;

/** Files whose contents can define an identifier the guidance quotes. */
const CODE_FILE = /\.(ts|tsx|mts|js|mjs|cjs|json|ya?ml|sh)$/;

/** Names the guidance quotes on purpose that no repo file defines (banned or third-party APIs). */
const EXTERNAL_NAMES = new Set(['localStorage']);

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
 * spaces and its first segment is a tracked top-level entry (`CLAUDE.md`,
 * `packages/…`, `.github/…`), so `raw/{tier}-{YYYY-MM}/` and `fix(ui): …` aren't.
 */
export function asRepoPath(span, topLevel) {
  if (/\s/.test(span)) return null;
  const first = span.split('/')[0];
  if (!topLevel.has(first)) return null;
  if (!span.includes('/') && !/\.[A-Za-z]+$/.test(span)) return null;
  return span;
}

/** Whether `path` (a file, a directory ending in /, or a glob) matches a tracked file. */
export function pathExists(path, tracked) {
  if (/[*{<]/.test(path)) {
    const pattern = path
      .replace(/[.+^$()|[\]\\]/g, '\\$&')
      .replace(/<[^>]+>/g, '[^/]+')
      .replace(/\*\*\//g, '(?:.+/)?')
      .replace(/\*/g, '[^/]*')
      .replace(/\{([^}]+)\}/g, (_, alts) => `(?:${alts.split(',').join('|')})`);
    const re = new RegExp(`^${pattern}${path.endsWith('/') ? '' : '(?:/|$)'}`);
    return tracked.some((f) => re.test(f));
  }
  const dir = path.endsWith('/') ? path : `${path}/`;
  return tracked.some((f) => f === path || f.startsWith(dir));
}

/** The code identifier a span names (camelCase or PascalCase, optional `()`), or null. */
export function asIdentifier(span) {
  const match = /^([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)(?:\(\))?$/.exec(span);
  return match ? match[1] : null;
}

/** The YAML frontmatter of a markdown file, or null when it has none. */
export function frontmatter(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
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
  const tracked = ['CLAUDE.md', 'packages/ui/src/api/CostApi.ts', 'e2e/views-core.test.ts', 'scripts/ci/a.test.mjs'];
  const topLevel = new Set(['CLAUDE.md', 'packages', 'e2e', 'scripts']);

  it('reads inline spans but skips fenced code', () => {
    const spans = codeSpans('see `a/b`\n```\n`not/this`\n```\nand `c`');
    expect(spans).toEqual([
      { text: 'a/b', line: 1 },
      { text: 'c', line: 5 },
    ]);
  });

  it('treats only spans rooted at a tracked top-level entry as paths', () => {
    expect(asRepoPath('packages/ui/src/api/CostApi.ts', topLevel)).toBe('packages/ui/src/api/CostApi.ts');
    expect(asRepoPath('CLAUDE.md', topLevel)).toBe('CLAUDE.md');
    expect(asRepoPath('raw/{tier}-{YYYY-MM}/', topLevel)).toBeNull();
    expect(asRepoPath('npm run build --workspace=packages/desktop', topLevel)).toBeNull();
    expect(asRepoPath('packages', topLevel)).toBeNull();
  });

  it('resolves files, directories, globs and <placeholders> against tracked files', () => {
    expect(pathExists('packages/ui/src/api/CostApi.ts', tracked)).toBe(true);
    expect(pathExists('packages/ui/', tracked)).toBe(true);
    expect(pathExists('packages/*/src/', tracked)).toBe(true);
    expect(pathExists('scripts/**/*.test.mjs', tracked)).toBe(true);
    expect(pathExists('e2e/<shard>.test.ts', tracked)).toBe(true);
    expect(pathExists('packages/ui/src/api/Gone.ts', tracked)).toBe(false);
    expect(pathExists('packages/core/', tracked)).toBe(false);
    expect(pathExists('packages/ui/src/api/Cost', tracked)).toBe(false);
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
    expect(skillProblems('---\nname: Run Desktop\n---\n')).toEqual([
      'name must be kebab-case',
      'frontmatter lacks `description`',
    ]);
  });
});

// ---------------------------------------------------------------- the real config

const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .stdout.split('\0')
  .filter(Boolean);
const read = (path) => readFileSync(new URL(path, repoRoot), 'utf8');
const gitarFiles = tracked.filter((f) => f.startsWith('.gitar/') && f.endsWith('.md'));
const topLevel = new Set(tracked.map((f) => f.split('/')[0]));

describe('gitar config (.gitar/)', () => {
  it('finds the files it polices', () => {
    expect(gitarFiles.some((f) => f.startsWith('.gitar/review/'))).toBe(true);
    expect(gitarFiles.some((f) => f.startsWith('.gitar/rules/'))).toBe(true);
  });

  it('quotes only repository paths that exist', () => {
    const missing = gitarFiles.flatMap((file) =>
      codeSpans(read(file))
        .map((span) => ({ ...span, path: asRepoPath(span.text, topLevel) }))
        .filter(({ path }) => path !== null && !pathExists(path, tracked))
        .map(({ path, line }) => `${file}:${line} names ${path}`),
    );
    expect(missing).toEqual([]);
  });

  it('quotes only identifiers that some code or config file still defines or uses', () => {
    const code = tracked
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
