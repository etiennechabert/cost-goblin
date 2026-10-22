import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { BuiltInDimension, CostApi, DimensionsConfig } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The region dimensions resolve raw codes (eu-central-1) to friendly names,
 *  countries or continents through the SSM region snapshot that Data
 *  Management syncs. The editor offers the Region dim a toggle for it, and
 *  explains when the snapshot is missing or its last sync failed. */

type RegionInfo = Awaited<ReturnType<CostApi['getRegionNamesInfo']>>;

const SERVICE: BuiltInDimension = { name: asDimensionId('service'), label: 'Service', field: 'service' };
const REGION: BuiltInDimension = { name: asDimensionId('region'), label: 'Region', field: 'region', useRegionNames: true };

function regionInfo(count: number, lastError: string | null = null): RegionInfo {
  return { count, syncedAt: '2026-04-30T00:00:00Z', lastError, regions: {} };
}

function renderView(regionDim: BuiltInDimension, info: RegionInfo) {
  const api: CostApi = new MockCostApi();
  const config: DimensionsConfig = { builtIn: [regionDim, SERVICE], tags: [] };
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(config);
  const regionInfoSpy = vi.spyOn(api, 'getRegionNamesInfo').mockResolvedValue(info);
  const discover = vi.spyOn(api, 'discoverColumnValues');
  const save = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { discover, regionInfoSpy, save, user };
}

/** Each config here has one dim on the `region` field, so its row is the only
 *  button whose text carries the lowercase field (pills show the label). */
async function openRegionEditor(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const row = await waitFor(() => {
    const found = screen.getAllByRole('button').find(b => b.textContent.includes('region'));
    if (found === undefined) throw new Error('region row not rendered yet');
    return found;
  });
  await user.click(row);
  await screen.findByLabelText('Display Label');
}

const MISSING = 'Region friendly names not available';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('BuiltInEditor — Region dimension', () => {
  it('resolves codes through the snapshot, and the toggle turns it off and on', async () => {
    const { discover, save, user } = renderView(REGION, regionInfo(30));
    await openRegionEditor(user);
    // The toggle only comes on once the snapshot info has loaded.
    expect(await screen.findByText(/Use friendly names \(e\.g\. "Europe \(Frankfurt\)"\)/)).toBeDefined();
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await waitFor(() => { expect(discover).toHaveBeenLastCalledWith('region', { useRegionNames: true }); });
    expect(screen.queryByText(MISSING)).toBeNull();

    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await waitFor(() => { expect(discover).toHaveBeenLastCalledWith('region', { useRegionNames: false }); });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: /Apply & rebuild/ }));
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
    // Saved explicitly false, so the default backfill can't turn it back on.
    expect(save.mock.calls[0]?.[0].builtIn[0]).toEqual({ ...REGION, useRegionNames: false });
  });

  it.each([
    ['has never been synced', null],
    ['holds no regions', regionInfo(0)],
  ])('explains raw codes and keeps the toggle off when the snapshot %s', async (_, info) => {
    const { user } = renderView(REGION, info);
    await openRegionEditor(user);
    expect(await screen.findByText(MISSING)).toBeDefined();
    expect(screen.getByText(/Region values will display as raw codes/)).toBeDefined();
    expect(screen.getByText('Sync Region Names from Data Management to enable.')).toBeDefined();

    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // Nothing to resolve with: the toggle does nothing.
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(MISSING)).toBeDefined();
  });

  it('shows why the last region sync failed', async () => {
    const { user } = renderView(REGION, regionInfo(30, 'AccessDeniedException: not authorized'));
    await openRegionEditor(user);
    expect(await screen.findByText(MISSING)).toBeDefined();
    expect(screen.getByText('AccessDeniedException: not authorized')).toBeDefined();
    expect(screen.getByText(/Last sync attempt failed/)).toBeDefined();
  });

  it('does not warn when friendly names are off', async () => {
    const { regionInfoSpy, user } = renderView({ ...REGION, useRegionNames: false }, null);
    await openRegionEditor(user);
    await waitFor(() => { expect(regionInfoSpy).toHaveBeenCalled(); });
    await screen.findByText(/Preview — 3 distinct values/);
    expect(screen.queryByText(MISSING)).toBeNull();
  });
});
