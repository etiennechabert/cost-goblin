// The Makefile is shorthand for the root package.json scripts, which are what
// CI and `npm run check` run. Its targets used to carry copies of those
// commands, and the copies drifted (#465): `make lint` skipped packages/mcp,
// `make e2e` ran 3 of CI's 9 suites, `make perf` named a suite that had moved
// to e2e/diag/, and `make release` bumped the version again, against the
// release flow in CLAUDE.md ("Versioning & releases").
//
// Like makefile-deps.test.mjs, this runs the real Makefile in temp directories:
// with fake `npm`/`npx` first on PATH, so nothing is built or installed, and
// for `make release` in a throwaway git repo whose `origin` is a local bare
// repo, so nothing reaches the network.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);
const makefile = fileURLToPath(new URL('Makefile', repoRoot));
const pkg = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

const hasMake = spawnSync('make', ['--version']).status === 0;
const hasGit = spawnSync('git', ['--version']).status === 0;

/**
 * The environment for a child make or git, minus what they would inherit from
 * a parent: MAKEFLAGS and friends carry a parent make's flags (a jobserver,
 * `-n`), and the GIT_* variables a git hook exports (GIT_INDEX_FILE, GIT_DIR)
 * while the pre-commit hook runs this suite would point every git command in a
 * temp repo at this checkout instead.
 */
function childEnv(extra) {
  const makeVars = new Set(['MAKEFLAGS', 'MFLAGS', 'GNUMAKEFLAGS', 'MAKEFILES', 'MAKELEVEL']);
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !makeVars.has(key));
  return { ...Object.fromEntries(inherited), ...extra };
}

describe('npm scripts behind the Makefile', () => {
  const workspaces = pkg.workspaces;

  it('type-checks and lints every workspace in `npm run lint`', () => {
    const steps = (pkg.scripts.lint ?? '').split('&&').map((step) => step.trim());
    const typechecked = steps.map((step) => /^tsc --noEmit -p (\S+)$/.exec(step)?.[1]).filter(Boolean);
    const linted = steps.filter((step) => /^eslint\s/.test(step)).flatMap((step) => step.split(/\s+/).slice(1));
    expect(workspaces.length).toBeGreaterThanOrEqual(4);
    expect(typechecked).toEqual(workspaces.map((ws) => `${ws}/tsconfig.json`));
    expect(linted).toEqual(expect.arrayContaining(workspaces.map((ws) => `${ws}/src/`)));
  });

  it('builds `npm run check` on `npm run lint`, so the gate and `make lint` cannot diverge', () => {
    expect(pkg.scripts.check).toBe('npm run lint && vitest run');
  });

  it('runs exactly the suites of the CI e2e shard matrix in `npm run e2e`', () => {
    const ci = parse(readFileSync(new URL('.github/workflows/ci.yml', repoRoot), 'utf8'));
    const shards = ci.jobs['test-e2e'].strategy.matrix.shard;
    const suites = [...pkg.scripts.e2e.matchAll(/\be2e\/([\w-]+)\.test\.ts\b/g)].map((match) => match[1]);
    expect(shards.length).toBeGreaterThan(0);
    expect([...suites].sort()).toEqual([...shards].sort());
  });

  it('names only e2e files that exist', () => {
    // `perf` pointed at e2e/perf.test.ts long after it moved to e2e/diag/,
    // where Playwright's default config no longer looks.
    const missing = Object.entries(pkg.scripts).flatMap(([name, body]) =>
      [...body.matchAll(/\be2e\/[\w./-]+\.ts\b/g)]
        .map((match) => match[0])
        .filter((path) => !existsSync(new URL(path, repoRoot)))
        .map((path) => `${name}: ${path}`),
    );
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!hasMake)('make targets that run an npm script', () => {
  let dir = '';
  let log = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'make-targets-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // Each fake records its call and succeeds, so a recipe that bypasses the
    // npm script (by running npx itself, say) shows up in the log.
    for (const tool of ['npm', 'npx']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "$FAKE_LOG"\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    log = join(dir, 'calls.log');
    writeFileSync(log, '');
    // `deps` has nothing to do: the lockfile matches the last install.
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'package-lock.json'), '{}\n');
    writeFileSync(join(dir, 'node_modules', '.installed-package-lock.json'), '{}\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['lint', 'lint'],
    ['e2e', 'e2e'],
    ['e2e-core', 'e2e:core'],
    ['e2e-config', 'e2e:config'],
    ['e2e-stress', 'e2e:stress'],
    ['perf', 'perf'],
    ['perf-queries', 'perf:queries'],
  ])('make %s runs `npm run %s` and nothing else', (target, script) => {
    expect(Object.keys(pkg.scripts)).toContain(script);
    const result = spawnSync('make', ['--no-print-directory', '-f', makefile, target], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv({ FAKE_LOG: log, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}` }),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual([`npm run ${script}`]);
  });

  it('declares every target .PHONY and lists it in make help', () => {
    const source = readFileSync(makefile, 'utf8');
    const targets = [...source.matchAll(/^([a-zA-Z0-9_-]+):(?!=)/gm)].map((match) => match[1]).sort();
    const phony = (/^\.PHONY:(.*)$/m.exec(source)?.[1] ?? '').trim().split(/\s+/).sort();
    const help = spawnSync('make', ['--no-print-directory', '-f', makefile, 'help'], {
      cwd: dir,
      encoding: 'utf8',
      env: childEnv({}),
    });
    // Each help line is `  <target>  <description>`, the name in ANSI color.
    const listed = help.stdout
      .split('\n')
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim().split(/\s+/)[0])
      .filter(Boolean)
      .sort();
    expect(targets.length).toBeGreaterThan(10);
    expect(phony).toEqual(targets);
    expect(listed).toEqual(targets);
  });
});

describe.skipIf(!hasMake || !hasGit)('make release', { timeout: 30_000 }, () => {
  let root = '';
  let repo = '';
  let origin = '';

  const env = () =>
    childEnv({
      // Only this suite's git settings: no signing, hooks or editor from the
      // developer's own config.
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      // Anything that opens an editor fails instead of waiting for input.
      GIT_EDITOR: 'false',
      // Stubs that fail stand in for npm/npx (tagging needs neither), then
      // this node for the target's `node -p`.
      PATH: [join(root, 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    });

  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: env() });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  function identify(path) {
    git(path, 'config', 'user.name', 'Release Test');
    git(path, 'config', 'user.email', 'release-test@example.invalid');
  }

  function clone(path) {
    git(root, 'clone', '-q', origin, path);
    identify(path);
  }

  function commit(cwd, message, files) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', message);
  }

  const manifest = (name, version) => `${JSON.stringify({ name, version }, null, 2)}\n`;
  const versions = (rootVersion, desktopVersion = rootVersion) => ({
    'package.json': manifest('costgoblin', rootVersion),
    'packages/desktop/package.json': manifest('@costgoblin/desktop', desktopVersion),
  });

  const tags = () => git(repo, 'tag', '--list').split('\n').filter(Boolean);

  function release() {
    const result = spawnSync('make', ['--no-print-directory', '-f', makefile, 'release'], {
      cwd: repo,
      encoding: 'utf8',
      env: env(),
      // No stdin and a deadline: the target must not prompt.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  beforeEach(() => {
    // origin's main, as CLAUDE.md describes it between two releases: v0.8.1 is
    // tagged, and the first PR after it bumped both manifests to 0.8.2.
    root = mkdtempSync(join(tmpdir(), 'make-release-'));
    writeFileSync(join(root, 'gitconfig'), '');
    mkdirSync(join(root, 'bin'));
    for (const tool of ['npm', 'npx']) {
      writeFileSync(join(root, 'bin', tool), `#!/bin/sh\necho "make release ran ${tool} $*" >&2\nexit 1\n`);
      chmodSync(join(root, 'bin', tool), 0o755);
    }
    origin = join(root, 'origin.git');
    repo = join(root, 'repo');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'init', '-q', '-b', 'main', repo);
    identify(repo);
    git(repo, 'remote', 'add', 'origin', origin);
    commit(repo, 'chore: release 0.8.1', versions('0.8.1'));
    git(repo, 'tag', 'v0.8.1');
    commit(repo, 'fix: first PR after v0.8.1', versions('0.8.2'));
    git(repo, 'push', '-q', 'origin', 'main', 'v0.8.1');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('tags the version main already carries: no bump, no commit, no push', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const { status, out } = release();
    expect(status, out).toBe(0);
    expect(tags()).toEqual(['v0.8.1', 'v0.8.2']);
    expect(git(repo, 'cat-file', '-t', 'v0.8.2')).toBe('tag');
    expect(git(repo, 'rev-parse', 'v0.8.2^{commit}')).toBe(head);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    // Pushing is left to the command it prints; that push starts release.yml.
    expect(git(repo, 'ls-remote', '--tags', 'origin', 'v0.8.2')).toBe('');
    expect(out).toContain('git push origin v0.8.2');
  });

  it('refuses when package.json and packages/desktop/package.json disagree', () => {
    commit(repo, 'fix: half a bump', versions('0.8.2', '0.8.1'));
    git(repo, 'push', '-q', 'origin', 'main');
    const { status, out } = release();
    expect(status).not.toBe(0);
    expect(out).toContain('packages/desktop/package.json');
    expect(out).toMatch(/0\.8\.2[\s\S]*0\.8\.1/);
    expect(tags()).toEqual(['v0.8.1']);
  });

  it('refuses a version that is not X.Y.Z instead of tagging `vundefined`', () => {
    commit(repo, 'chore: no version', {
      'package.json': `${JSON.stringify({ name: 'costgoblin' })}\n`,
      'packages/desktop/package.json': `${JSON.stringify({ name: '@costgoblin/desktop' })}\n`,
    });
    git(repo, 'push', '-q', 'origin', 'main');
    const { status, out } = release();
    expect(status).not.toBe(0);
    expect(out).toContain('X.Y.Z');
    expect(tags()).toEqual(['v0.8.1']);
  });

  it('refuses when the tag already exists, and leaves it where it was', () => {
    git(repo, 'tag', 'v0.8.2', 'HEAD~1');
    const tagged = git(repo, 'rev-parse', 'v0.8.2');
    const { status, out } = release();
    expect(status).not.toBe(0);
    expect(out).toContain('v0.8.2 already exists');
    expect(git(repo, 'rev-parse', 'v0.8.2')).toBe(tagged);
  });

  it('refuses a tag pushed from another clone that this one has not fetched yet', () => {
    const other = join(root, 'other');
    clone(other);
    git(other, 'tag', 'v0.8.2');
    git(other, 'push', '-q', 'origin', 'v0.8.2');
    const { status, out } = release();
    expect(status).not.toBe(0);
    expect(out).toContain('v0.8.2 already exists');
  });

  it('refuses with uncommitted changes, which the tag would not contain', () => {
    // A version edited but never committed: read as-is, it would put v0.8.3 on
    // a commit that still says 0.8.2, which release.yml rejects.
    writeFileSync(join(repo, 'package.json'), manifest('costgoblin', '0.8.3'));
    const { status, out } = release();
    expect(status).not.toBe(0);
    expect(out).toContain('uncommitted changes');
    expect(tags()).toEqual(['v0.8.1']);
  });

  it('ignores untracked files, which no tag contains', () => {
    writeFileSync(join(repo, 'notes.txt'), 'scratch\n');
    const { status, out } = release();
    expect(status, out).toBe(0);
    expect(tags()).toEqual(['v0.8.1', 'v0.8.2']);
  });

  it('refuses when HEAD has commits origin/main does not', () => {
    commit(repo, 'wip: never pushed', { 'wip.txt': 'local only\n' });
    const { status, out } = release();
    expect(status).not.toBe(0);
    expect(out).toContain('HEAD is not origin/main');
    expect(tags()).toEqual(['v0.8.1']);
  });

  it('fetches origin first, so a main that missed a merge is refused', () => {
    const other = join(root, 'other');
    clone(other);
    commit(other, 'fix: merged after the last pull', { 'merged.txt': 'merged upstream\n' });
    git(other, 'push', '-q', 'origin', 'main');

    const { status, out } = release();
    expect(status).not.toBe(0);
    expect(out).toContain('HEAD is not origin/main');
    expect(tags()).toEqual(['v0.8.1']);
  });

  it('only warns when origin cannot be fetched, and checks the last-fetched origin/main', () => {
    git(repo, 'remote', 'set-url', 'origin', join(root, 'unreachable.git'));
    const { status, out } = release();
    expect(status, out).toBe(0);
    expect(out).toContain('could not fetch origin');
    expect(tags()).toEqual(['v0.8.1', 'v0.8.2']);
  });
});
