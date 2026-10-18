import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDimensionId, OU_PATH_SOURCE_KEY } from '@costgoblin/core/browser';
import type { CostApi, TagDimension } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The tag editor shows only some of a tag's fields. Saving an edit rewrites
 *  those and must keep the rest as the config file has them: a description, a
 *  separator, a path segment on a source other than the OU Path. Rebuilding
 *  the tag from the editor alone dropped them on every save. */

const TEAM: TagDimension = {
  tagName: 'team',
  label: 'Team',
  description: 'Owning squad',
  separator: '/',
  pathSegment: { separator: '/', index: 1 },
};

const DEPARTMENT: TagDimension = {
  label: 'Department',
  accountTagFallback: OU_PATH_SOURCE_KEY,
  description: 'Second level of the OU tree',
  pathSegment: { separator: ' / ', index: 2 },
};

function renderView(tags: readonly TagDimension[]) {
  // Typed as the interface so the spy carries saveDimensionsConfig's real
  // parameters (the mock's own override declares none).
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
    builtIn: [{ name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' }],
    tags: [...tags],
  });
  const saveSpy = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { saveSpy, user };
}

/** Saves the open editor, applies the draft, and returns the tags persisted. */
async function saveAndApply(
  user: ReturnType<typeof userEvent.setup>,
  saveSpy: ReturnType<typeof renderView>['saveSpy'],
): Promise<readonly TagDimension[]> {
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await user.click(await screen.findByRole('button', { name: /Apply & rebuild/i }));
  await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(1); });
  const saved = saveSpy.mock.calls[0]?.[0];
  if (saved === undefined) throw new Error('saveDimensionsConfig was called without a config');
  return saved.tags;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DimensionsView — saving a tag edit', () => {
  it('keeps the description, separator and path segment the editor does not show', async () => {
    const { saveSpy, user } = renderView([TEAM]);
    await user.click(await screen.findByRole('button', { name: /tag:team/ }));
    const label = await screen.findByDisplayValue('Team');
    await user.clear(label);
    await user.type(label, 'Teams');

    expect(await saveAndApply(user, saveSpy)).toEqual([{ ...TEAM, label: 'Teams' }]);
  });

  it('rewrites the OU Path segment from the editor, keeping the description', async () => {
    const { saveSpy, user } = renderView([DEPARTMENT]);
    await user.click(await screen.findByRole('button', { name: /source: OU Path/ }));
    const segment = await screen.findByDisplayValue('2');
    await user.clear(segment);
    await user.type(segment, '-1');

    expect(await saveAndApply(user, saveSpy)).toEqual([
      { ...DEPARTMENT, pathSegment: { separator: ' / ', index: -1 } },
    ]);
  });

  it('drops the OU Path segment when its field is cleared', async () => {
    const { saveSpy, user } = renderView([DEPARTMENT]);
    await user.click(await screen.findByRole('button', { name: /source: OU Path/ }));
    await user.clear(await screen.findByDisplayValue('2'));

    expect(await saveAndApply(user, saveSpy)).toEqual([{
      label: 'Department',
      accountTagFallback: OU_PATH_SOURCE_KEY,
      description: 'Second level of the OU tree',
    }]);
  });

  it('drops the OU Path segment when the OU Path stops being the source', async () => {
    const teamWithOuFallback: TagDimension = {
      tagName: 'team',
      label: 'Team',
      accountTagFallback: OU_PATH_SOURCE_KEY,
      description: 'Owning squad',
      pathSegment: { separator: ' / ', index: 2 },
    };
    const { saveSpy, user } = renderView([teamWithOuFallback]);
    await user.click(await screen.findByRole('button', { name: /tag:team/ }));
    await user.selectOptions(await screen.findByDisplayValue('OU Path'), 'No fallback');

    expect(await saveAndApply(user, saveSpy)).toEqual([
      { tagName: 'team', label: 'Team', description: 'Owning squad' },
    ]);
  });

  // The second tag has none of the fields the editor leaves out: saving it
  // clears every optional field it does show, which must not count as a change.
  it.each([
    { name: 'one the editor does not fully show', tag: TEAM },
    { name: 'one it fully shows', tag: { tagName: 'env', label: 'Environment', concept: 'environment' } satisfies TagDimension },
  ])('leaves the draft clean when a tag is saved unchanged: $name', async ({ tag }) => {
    const { saveSpy, user } = renderView([tag]);
    await user.click(await screen.findByRole('button', { name: new RegExp(`tag:${tag.tagName ?? ''}`) }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Save' })).toBeNull(); });
    expect(screen.getByText('Saved')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Apply & rebuild/i })).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
