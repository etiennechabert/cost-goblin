// Supply-chain policy for the GitHub workflows (#596, VULN-001/019/020/021).
//
// The release pipeline signs, notarizes and publishes the app, so any code that
// runs there before or beside the signing step can tamper with what ships. This
// suite pins the invariants that keep that code lockfile-only and the tokens
// least-privilege, so a later edit can't quietly reintroduce a run-time-resolved
// `npx pkg@^N`, a persisted checkout token, or a stray write scope.
//
// Each checker is a pure function over parsed workflow YAML and is self-tested
// on inline YAML first, so a checker that silently matches nothing can't make
// the real-workflow assertions pass vacuously.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = new URL('../../', import.meta.url);
const workflowsDir = new URL('.github/workflows/', repoRoot);

const NODE_VERSION = '^24.18.0';
/** The only jobs that may hold a write scope: they create and publish the release. */
const WRITE_JOBS = { 'release.yml': ['publish', 'notes'] };

/** Run-body patterns that resolve or execute code outside package-lock.json. */
const FORBIDDEN_RUN_PATTERNS = [
  // npx without --no-install falls back to fetching from the registry.
  /\bnpx\b(?!\s+--no-install\b)/,
  // Any of these re-resolves against the registry instead of the lockfile.
  /\bnpm\s+(install|i|add|exec|x|update|up)\b/,
  // Only ever needed to run an unpinned package's install script.
  /--allow-scripts\b/,
  // A version range on a package spec (`pkg@^2`, `@scope/pkg@~1`).
  /[\w/-]@[\^~]/,
  /\b(yarn|pnpm)\s+dlx\b/,
];

// ---------------------------------------------------------------- helpers

function loadWorkflows() {
  return readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((name) => ({ name, wf: parse(readFileSync(new URL(name, workflowsDir), 'utf8')) }));
}

function jobsOf(wf) {
  return Object.entries(wf.jobs ?? {});
}

function stepsOf(job) {
  return Array.isArray(job.steps) ? job.steps : [];
}

function usesAction(step, action) {
  return typeof step.uses === 'string' && step.uses.startsWith(`${action}@`);
}

/** A run body with its whole-line shell comments removed. */
function runBody(step) {
  if (typeof step.run !== 'string') return '';
  return step.run
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function isWriteScope(permissions) {
  if (permissions === 'write-all') return true;
  if (permissions && typeof permissions === 'object') {
    return Object.values(permissions).some((v) => v === 'write');
  }
  return false;
}

/** Matches `npm ci` as a command (not `npm ci-foo`), with its trailing flags. */
const NPM_CI = /\bnpm\s+ci\b([^\n;&|]*)/g;

function npmCiInvocations(step) {
  return [...runBody(step).matchAll(NPM_CI)].map((m) => m[1].trim());
}

const ASSERT_SCRIPT = '.github/scripts/assert-npm-guards.sh';

// ---------------------------------------------------------------- checkers

function checkTopLevelPermissions(name, wf) {
  return 'permissions' in wf ? [] : [`${name}: no top-level permissions block`];
}

function checkCheckouts(name, wf) {
  const violations = [];
  let count = 0;
  for (const [jobName, job] of jobsOf(wf)) {
    for (const step of stepsOf(job)) {
      if (!usesAction(step, 'actions/checkout')) continue;
      count += 1;
      if (step.with?.['persist-credentials'] !== false) {
        violations.push(`${name} ${jobName}: checkout without persist-credentials: false`);
      }
    }
  }
  return { count, violations };
}

function checkWriteScopes(name, wf) {
  const allowed = WRITE_JOBS[name] ?? [];
  const violations = [];
  if (isWriteScope(wf.permissions)) violations.push(`${name}: top-level write scope`);
  for (const [jobName, job] of jobsOf(wf)) {
    if (isWriteScope(job.permissions) && !allowed.includes(jobName)) {
      violations.push(`${name} ${jobName}: write scope outside ${JSON.stringify(allowed)}`);
    }
  }
  return violations;
}

function checkSetupNode(name, wf) {
  const violations = [];
  let count = 0;
  for (const [jobName, job] of jobsOf(wf)) {
    for (const step of stepsOf(job)) {
      if (!usesAction(step, 'actions/setup-node')) continue;
      count += 1;
      const v = step.with?.['node-version'];
      if (v !== NODE_VERSION) {
        violations.push(`${name} ${jobName}: setup-node node-version ${JSON.stringify(v)}`);
      }
    }
  }
  return { count, violations };
}

function checkRunBodies(name, wf) {
  const violations = [];
  for (const [jobName, job] of jobsOf(wf)) {
    for (const step of stepsOf(job)) {
      const body = runBody(step);
      for (const pattern of FORBIDDEN_RUN_PATTERNS) {
        const hit = body.match(pattern);
        if (hit) {
          const label = step.name ?? step.run.split('\n')[0];
          violations.push(`${name} ${jobName} "${label}": ${pattern} matched "${hit[0]}"`);
        }
      }
    }
  }
  return violations;
}

/** Every job that runs `npm ci` must run the guard assertion in an earlier step. */
function checkAssertBeforeNpmCi(name, wf) {
  const violations = [];
  for (const [jobName, job] of jobsOf(wf)) {
    let asserted = false;
    for (const step of stepsOf(job)) {
      if (npmCiInvocations(step).length > 0 && !asserted) {
        violations.push(`${name} ${jobName}: npm ci before ${ASSERT_SCRIPT}`);
      }
      if (runBody(step).includes(ASSERT_SCRIPT)) asserted = true;
    }
  }
  return violations;
}

/** The job that runs the manifest merge (contents: write) installs with no scripts. */
function checkMergeJobIgnoresScripts(name, wf) {
  const violations = [];
  let mergeJobs = 0;
  for (const [jobName, job] of jobsOf(wf)) {
    const steps = stepsOf(job);
    if (!steps.some((s) => runBody(s).includes('merge-update-manifests.mjs'))) continue;
    mergeJobs += 1;
    const installs = steps.flatMap(npmCiInvocations);
    if (installs.length === 0) violations.push(`${name} ${jobName}: merge job never runs npm ci`);
    for (const flags of installs) {
      if (!/(^|\s)--ignore-scripts(\s|$)/.test(flags)) {
        violations.push(`${name} ${jobName}: merge job runs npm ci without --ignore-scripts`);
      }
    }
  }
  return { mergeJobs, violations };
}

function allSteps(wf) {
  return jobsOf(wf).flatMap(([jobName, job]) => stepsOf(job).map((step) => ({ jobName, step })));
}

// ---------------------------------------------------------------- self-tests

describe('workflow policy checkers (self-test on inline YAML)', () => {
  const bad = parse(`
jobs:
  build:
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@abc
      - uses: actions/setup-node@abc
        with:
          node-version: 24
      - run: npm ci
      - run: npx @sentry/cli@^2 x
      - run: |
          npm install --no-save js-yaml@^4
          node .github/scripts/merge-update-manifests.mjs a b c
  all:
    permissions: write-all
    steps: []
`);

  const good = parse(`
permissions: {}
jobs:
  publish:
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@abc
        with:
          persist-credentials: false
      - uses: actions/setup-node@abc
        with:
          node-version: '^24.18.0'
      - run: bash .github/scripts/assert-npm-guards.sh
      - run: npm ci --ignore-scripts
      - run: |
          # npx @sentry/cli@^2 used to run here
          npx --no-install electron-builder --mac
          node .github/scripts/merge-update-manifests.mjs a b c
`);

  it('flags a missing top-level permissions block', () => {
    expect(checkTopLevelPermissions('release.yml', bad)).toHaveLength(1);
    expect(checkTopLevelPermissions('release.yml', good)).toEqual([]);
  });

  it('flags a checkout that persists its token', () => {
    expect(checkCheckouts('release.yml', bad)).toEqual({
      count: 1,
      violations: ['release.yml build: checkout without persist-credentials: false'],
    });
    expect(checkCheckouts('release.yml', good)).toEqual({ count: 1, violations: [] });
  });

  it('flags a stray write scope but allows it on publish/notes in release.yml', () => {
    expect(checkWriteScopes('release.yml', bad)).toHaveLength(2);
    expect(checkWriteScopes('release.yml', good)).toEqual([]);
    expect(checkWriteScopes('ci.yml', good)).toHaveLength(1);
    expect(checkWriteScopes('x.yml', { permissions: { contents: 'write' }, jobs: {} })).toHaveLength(1);
  });

  it('flags a setup-node without the pinned node-version range', () => {
    expect(checkSetupNode('ci.yml', bad).violations).toHaveLength(1);
    expect(checkSetupNode('ci.yml', good)).toEqual({ count: 1, violations: [] });
  });

  it('flags run-time-resolved packages but not comments or npx --no-install', () => {
    const hits = checkRunBodies('release.yml', bad);
    expect(hits.some((h) => h.includes('npx @sentry/cli@^2'))).toBe(true);
    expect(hits.some((h) => h.includes('npm install'))).toBe(true);
    expect(hits.some((h) => h.includes('js-yaml@^'))).toBe(true);
    expect(checkRunBodies('release.yml', good)).toEqual([]);
  });

  it.each([
    'npx --yes --allow-scripts=@sentry/cli @sentry/cli@^2 sourcemaps inject out',
    'npx sentry-cli --version',
    'npm i left-pad',
    'npm exec -- foo',
    'npm update',
    'pnpm dlx foo',
    'yarn dlx foo',
    'node x.js @scope/pkg@~1',
  ])('flags run body %j', (run) => {
    expect(checkRunBodies('release.yml', { jobs: { j: { steps: [{ run }] } } })).not.toEqual([]);
  });

  it('requires the guard assertion before any npm ci', () => {
    expect(checkAssertBeforeNpmCi('release.yml', bad)).toEqual(['release.yml build: npm ci before .github/scripts/assert-npm-guards.sh']);
    expect(checkAssertBeforeNpmCi('release.yml', good)).toEqual([]);
  });

  it('requires --ignore-scripts on npm ci in the manifest-merge job', () => {
    expect(checkMergeJobIgnoresScripts('release.yml', bad)).toEqual({
      mergeJobs: 1,
      violations: ['release.yml build: merge job runs npm ci without --ignore-scripts'],
    });
    expect(checkMergeJobIgnoresScripts('release.yml', good)).toEqual({ mergeJobs: 1, violations: [] });
  });
});

// ---------------------------------------------------------------- real workflows

describe('workflow policy (.github/workflows)', () => {
  const workflows = loadWorkflows();
  const byName = Object.fromEntries(workflows.map(({ name, wf }) => [name, wf]));
  const release = byName['release.yml'];
  const ci = byName['ci.yml'];

  it('finds the workflows it polices', () => {
    expect(release).toBeDefined();
    expect(ci).toBeDefined();
  });

  it('declares top-level permissions in every workflow', () => {
    expect(workflows.flatMap(({ name, wf }) => checkTopLevelPermissions(name, wf))).toEqual([]);
  });

  it('never persists the checkout token', () => {
    const results = workflows.map(({ name, wf }) => checkCheckouts(name, wf));
    expect(results.reduce((n, r) => n + r.count, 0)).toBeGreaterThanOrEqual(8);
    expect(results.flatMap((r) => r.violations)).toEqual([]);
  });

  it('grants write scopes only to release.yml publish and notes', () => {
    expect(workflows.flatMap(({ name, wf }) => checkWriteScopes(name, wf))).toEqual([]);
  });

  it('release.yml defaults every job to no permissions', () => {
    expect(release.permissions).toEqual({});
  });

  it('ci.yml grants read-only contents', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
  });

  it(`pins every setup-node to ${NODE_VERSION} (npm >= 11.16)`, () => {
    const results = workflows.map(({ name, wf }) => checkSetupNode(name, wf));
    expect(results.reduce((n, r) => n + r.count, 0)).toBeGreaterThanOrEqual(6);
    expect(results.flatMap((r) => r.violations)).toEqual([]);
  });

  it('release.yml runs only lockfile-pinned code', () => {
    expect(checkRunBodies('release.yml', release)).toEqual([]);
  });

  it('release.yml asserts the npm guards before every npm ci', () => {
    expect(checkAssertBeforeNpmCi('release.yml', release)).toEqual([]);
  });

  // CLAUDE.md promises this for every CI/release job, not just release.yml and
  // ci.yml's security-audit: the guards fail open on an npm that doesn't know
  // them, and any job's `npm ci` runs dependency install scripts.
  it('every workflow asserts the npm guards before every npm ci', () => {
    expect(workflows.flatMap(({ name, wf }) => checkAssertBeforeNpmCi(name, wf))).toEqual([]);
  });

  it('release.yml installs with --ignore-scripts in the manifest-merge job', () => {
    expect(checkMergeJobIgnoresScripts('release.yml', release)).toEqual({ mergeJobs: 1, violations: [] });
  });

  it('release.yml hard-fails a broken Sentry debug-ID inject, without a token', () => {
    const inject = allSteps(release).filter(({ step }) => runBody(step).includes('sourcemaps inject'));
    expect(inject).toHaveLength(1);
    const [{ step }] = inject;
    expect(step['continue-on-error'] ?? false).toBe(false);
    expect(runBody(step)).not.toMatch(/\bupload\b/);
    expect(JSON.stringify(step.env ?? {})).not.toContain('SENTRY_AUTH_TOKEN');
    expect(runBody(step)).toMatch(/^node node_modules\/@sentry\/cli\/bin\/sentry-cli sourcemaps inject\b/);
  });

  it('release.yml runs sentry-cli only from the lockfile-installed package path', () => {
    // Not `npx --no-install sentry-cli`: npm 11.16/11.17 don't link .bin for a
    // package whose install script is denied, so npx would find nothing.
    const calls = allSteps(release)
      .flatMap(({ step }) => runBody(step).split('\n'))
      .filter((line) => /\bsentry-cli\b/.test(line));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const line of calls) {
      expect(line.trim()).toMatch(/^node node_modules\/@sentry\/cli\/bin\/sentry-cli /);
    }
  });

  it('ci.yml fails the sonarcloud job on a failed quality gate for pull requests', () => {
    // Without the wait the scan only uploads and the job is always green, so a
    // red gate never reaches the required `sonarcloud` check.
    const job = ci.jobs.sonarcloud;
    const scan = stepsOf(job).find((s) => usesAction(s, 'SonarSource/sonarqube-scan-action'));
    expect(scan).toBeDefined();
    const args = String(scan?.with?.args ?? '');
    expect(args).toContain("github.event_name == 'pull_request'");
    expect(args).toContain('-Dsonar.qualitygate.wait=true');
    expect(job['continue-on-error']).toBeUndefined();
    expect(scan?.['continue-on-error']).toBeUndefined();
  });

  it('ci.yml security-audit asserts the npm guards before npm ci', () => {
    const steps = stepsOf(ci.jobs['security-audit']);
    const assertAt = steps.findIndex((s) => runBody(s).includes(ASSERT_SCRIPT));
    const ciAt = steps.findIndex((s) => npmCiInvocations(s).length > 0);
    expect(assertAt).toBeGreaterThanOrEqual(0);
    expect(ciAt).toBeGreaterThan(assertAt);
  });
});

// ---------------------------------------------------------------- npm settings

function readNpmrc() {
  const entries = {};
  for (const raw of readFileSync(new URL('.npmrc', repoRoot), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq > 0) entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return entries;
}

describe('npm supply-chain settings', () => {
  const npmrc = readNpmrc();
  const pkg = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8'));

  it('.npmrc enables strict-allow-scripts, engine-strict and a min-release-age', () => {
    expect(npmrc['strict-allow-scripts']).toBe('true');
    expect(npmrc['engine-strict']).toBe('true');
    expect(npmrc['min-release-age']).toMatch(/^[0-9]+$/);
    expect(Number(npmrc['min-release-age'])).toBeGreaterThanOrEqual(1);
  });

  it('root package.json pins the release tooling as devDependencies', () => {
    expect(pkg.devDependencies).toHaveProperty('@sentry/cli');
    expect(pkg.devDependencies).toHaveProperty('js-yaml');
  });

  it('denies @sentry/cli its install script (the binary comes from its platform optionals)', () => {
    expect(pkg.allowScripts['@sentry/cli']).toBe(false);
  });

  it('does not disable the root engines check with devEngines', () => {
    expect(pkg).not.toHaveProperty('devEngines');
  });
});
