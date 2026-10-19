// The GCP exporter ships as a release asset, gcp-focus-exporter.tar.gz, which
// the exporter README and costgoblin.com download into Cloud Shell. "Open in
// Cloud Shell" links can only clone the whole repository (they have no shallow
// or sparse option): ~30 MB of history for a ~50 KB folder.
//
// Pinned here: what .github/scripts/pack-gcp-exporter.sh puts in the archive,
// that release.yml uploads it with the other release assets, and that every
// doc downloads that exact asset rather than cloning the repository.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = '.github/scripts/pack-gcp-exporter.sh';
const SOURCE = 'scripts/gcp-focus-exporter/';
const FOLDER = 'gcp-focus-exporter';
const ASSET = `${FOLDER}.tar.gz`;
const ASSET_URL = `https://github.com/etiennechabert/cost-goblin/releases/latest/download/${ASSET}`;
const DOCS = ['README.md', 'scripts/gcp-focus-exporter/README.md', 'scripts/gcp-focus-exporter/deploy.sh', 'docs/index.html'];

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? filesUnder(dir, rel) : [rel];
  });
}

describe('pack-gcp-exporter.sh', () => {
  let tmp;
  let unpacked;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pack-gcp-exporter-'));
    // A relative output path, as release.yml passes it, run from a subdirectory.
    mkdirSync(join(tmp, 'out'));
    run('bash', [join(repoRoot, SCRIPT), `out/${ASSET}`], tmp);
    unpacked = join(tmp, 'unpacked');
    mkdirSync(unpacked);
    run('tar', ['-xzf', join(tmp, 'out', ASSET), '-C', unpacked], tmp);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('unpacks into the one folder the docs cd into', () => {
    expect(readdirSync(unpacked)).toEqual([FOLDER]);
  });

  it('holds every committed exporter file except the tests', () => {
    const committed = run('git', ['ls-tree', '-r', '--name-only', 'HEAD', SOURCE], repoRoot)
      .split('\n')
      .filter((path) => path !== '')
      .map((path) => path.slice(SOURCE.length));
    const expected = committed.filter((file) => !file.endsWith('.test.mjs'));
    expect(expected).toEqual(expect.arrayContaining(['deploy.sh', 'Dockerfile', 'export-focus.mjs']));
    expect(expected.length).toBeLessThan(committed.length);
    expect(filesUnder(join(unpacked, FOLDER)).sort()).toEqual(expected.sort());
  });

  it('keeps deploy.sh executable', () => {
    expect(statSync(join(unpacked, FOLDER, 'deploy.sh')).mode & 0o111).toBe(0o111);
  });

  it('builds the same bytes on a re-run', () => {
    run('bash', [join(repoRoot, SCRIPT), join(tmp, 'again.tar.gz')], repoRoot);
    expect(readFileSync(join(tmp, 'again.tar.gz')).equals(readFileSync(join(tmp, 'out', ASSET)))).toBe(true);
  });
});

describe('the gcp-focus-exporter.tar.gz release asset', () => {
  it('is staged in release.yml before the upload of upload/*', () => {
    const release = parse(readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8'));
    const steps = release.jobs.publish.steps.map((step) => (typeof step.run === 'string' ? step.run : ''));
    const pack = steps.findIndex((body) => body.includes(`bash ${SCRIPT} upload/${ASSET}`));
    const upload = steps.findIndex((body) => /gh release upload .* upload\/\*/.test(body));
    expect(pack).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(pack);
  });

  it('is what the exporter README and the website download, with no repository clone left', () => {
    for (const doc of ['scripts/gcp-focus-exporter/README.md', 'docs/index.html']) {
      const text = readFileSync(join(repoRoot, doc), 'utf8');
      expect(text, doc).toContain(`curl -fsSL ${ASSET_URL} | tar xz`);
      expect(text, doc).toContain(`cd ${FOLDER}`);
    }
    for (const doc of DOCS) {
      expect(readFileSync(join(repoRoot, doc), 'utf8'), doc).not.toContain('cloudshell_git_repo');
    }
  });
});
