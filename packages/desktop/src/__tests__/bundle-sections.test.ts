import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, loadViews } from '@costgoblin/core';
import { optionalSection } from '../main/handlers/bundle-sections.js';

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
    await expect(failed).rejects.toMatchObject({ cause: expect.any(ConfigValidationError) });
  });

  it('leaves a file that does not load out when told to skip it', async () => {
    await writeFile(viewsPath, VALID_VIEWS_YAML.replace('size: large', 'size: jumbo'));

    await expect(optionalSection(viewsPath, load, 'skip')).resolves.toBeUndefined();
  });
});
