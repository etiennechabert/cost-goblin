import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, loadCostScope, loadOrgTree, loadViews, ManifestUnavailableError } from '@costgoblin/core';
import { BrokenSectionError, optionalSection, peerManifestError } from '../main/handlers/bundle-sections.js';

let dir: string;
let viewsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-bundle-sections-'));
  viewsPath = join(dir, 'views.yaml');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const load = () => loadViews(viewsPath);

const VALID_VIEWS_YAML = `views:
  - id: team-costs
    name: Team costs
    rows:
      - widgets:
          - id: team-top
            type: topNBar
            size: large
            groupBy: service
            topN: 5
`;

describe('optionalSection', () => {
  it.each(['fail', 'skip'] as const)('leaves a missing file out (%s)', async (onBroken) => {
    await expect(optionalSection(viewsPath, load, onBroken)).resolves.toBeUndefined();
  });

  it('includes a file that loads', async () => {
    await writeFile(viewsPath, VALID_VIEWS_YAML);

    const views = await optionalSection(viewsPath, load, 'fail');

    expect(views?.views.map(v => v.id)).toEqual(['team-costs']);
  });

  it('fails the bundle on a file that does not load, naming it', async () => {
    await writeFile(viewsPath, VALID_VIEWS_YAML.replace('topN: 5', 'topN: "5"'));

    const failed = optionalSection(viewsPath, load, 'fail');

    await expect(failed).rejects.toThrow(
      "Couldn't load views.yaml for the configuration bundle: views[0].rows[0].widgets[0].topN must be a number",
    );
    await expect(failed).rejects.toMatchObject({ file: 'views.yaml', cause: expect.any(ConfigValidationError) });
    await expect(failed).rejects.toBeInstanceOf(BrokenSectionError);
  });

  it('leaves a file that does not load out when told to skip it', async () => {
    await writeFile(viewsPath, VALID_VIEWS_YAML.replace('size: large', 'size: jumbo'));

    await expect(optionalSection(viewsPath, load, 'skip')).resolves.toBeUndefined();
  });

  // Both used to be dropped from exports, publishes and LAN shares without a
  // word (`.catch(() => undefined)`): a receiver then saw other numbers.
  it('fails the bundle on a cost-scope.yaml that does not load', async () => {
    const costScopePath = join(dir, 'cost-scope.yaml');
    await writeFile(costScopePath, 'costMetric: effective\nrules: none\n');

    const failed = optionalSection(costScopePath, () => loadCostScope(costScopePath), 'fail');

    await expect(failed).rejects.toThrow("Couldn't load cost-scope.yaml for the configuration bundle: costScope.rules must be an array");
    await expect(failed).rejects.toMatchObject({ file: 'cost-scope.yaml' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails the bundle on an org-tree.yaml it cannot read', async () => {
    const orgTreePath = join(dir, 'org-tree.yaml');
    await writeFile(orgTreePath, 'tree: []\n');
    await chmod(orgTreePath, 0o200);

    const failed = optionalSection(orgTreePath, () => loadOrgTree(orgTreePath), 'fail');

    await expect(failed).rejects.toMatchObject({ file: 'org-tree.yaml', cause: { code: 'EACCES' } });
  });
});

describe('peerManifestError', () => {
  it('tells a pulling peer which file does not load, without the local error', () => {
    const broken = new BrokenSectionError(
      join(dir, 'cost-scope.yaml'),
      Object.assign(new Error(`EACCES: permission denied, open '${join(dir, 'cost-scope.yaml')}'`), { code: 'EACCES' }),
    );

    const err = peerManifestError(broken);

    expect(err).toBeInstanceOf(ManifestUnavailableError);
    expect(err).toMatchObject({ file: 'cost-scope.yaml', cause: broken });
    expect(err.message).not.toContain(dir);
  });

  it('passes any other failure through as it is', () => {
    const other = new Error('ENOENT: no such file or directory, scandir');

    expect(peerManifestError(other)).toBe(other);
  });
});
