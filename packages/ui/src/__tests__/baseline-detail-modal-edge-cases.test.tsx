import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { BaselineDetail, BaselineRecord, BaselineUpdatePatch } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { BaselineDetailModal } from '../components/baseline-detail-modal.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { baselineDetail, baselineRecord, baselineSpec, deferred, rejectWith } from './baseline-fixtures.js';

const ID = 'b-1';
const NOTE_PLACEHOLDER = 'Add a note (optional)…';

/** Serves one baseline — or, first, each queued result in turn — and records
 *  every load and write the modal makes. */
class DetailApi extends MockCostApi {
  readonly detail: BaselineDetail | null;
  readonly loads: (() => Promise<BaselineDetail | null>)[] = [];
  readonly getCalls: (string | undefined)[] = [];
  readonly patches: (BaselineUpdatePatch | undefined)[] = [];

  constructor(detail: BaselineDetail | null) {
    super();
    this.detail = detail;
  }

  override getBaseline(id?: string): Promise<BaselineDetail | null> {
    this.getCalls.push(id);
    return this.loads.shift()?.() ?? Promise.resolve(this.detail);
  }

  override updateBaseline(_id?: string, patch?: BaselineUpdatePatch): Promise<BaselineRecord | null> {
    this.patches.push(patch);
    return Promise.resolve(null);
  }
}

function apiFor(detail: BaselineDetail | null = baselineDetail(baselineRecord())): DetailApi {
  return new DetailApi(detail);
}

function renderModal(api: DetailApi) {
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <BaselineDetailModal id={ID} onClose={vi.fn()} onChanged={vi.fn()} />
    </CostApiProvider>,
  );
  return { user };
}

/** The detail body has rendered — the chart only exists inside it. */
async function bodyReady(): Promise<HTMLElement> {
  return screen.findByRole('img', { name: 'Daily cost history' });
}

/** The $/day line of a run-rate stat card; its next sibling is the $/mo line. */
function statValue(label: string): HTMLElement {
  const value = screen.getByText(label, { selector: 'p' }).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for "${label}"`);
  return value;
}

function bandLabel(edge: 'lower' | 'upper'): string | null {
  return screen.getByText(new RegExp(`^${edge} `)).textContent;
}

function modeButton(name: 'Absolute $' | 'Percentile'): HTMLElement {
  return screen.getByRole('button', { name });
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save changes' });
}

/** Saves a note and waits for the write. */
async function saveNote(user: ReturnType<typeof userEvent.setup>, api: DetailApi, text: string): Promise<void> {
  await user.type(screen.getByPlaceholderText(NOTE_PLACEHOLDER), text);
  await user.click(saveButton());
  await waitFor(() => { expect(api.patches).toHaveLength(1); });
}

describe('BaselineDetailModal — load failure', () => {
  it('shows why the baseline could not load, and loads it on Retry', async () => {
    const api = apiFor();
    api.loads.push(() => rejectWith(new Error('Database is locked')));
    const { user } = renderModal(api);

    expect(await screen.findByText("Couldn't load this baseline: Database is locked")).toBeDefined();
    expect(screen.queryByRole('img', { name: 'Daily cost history' })).toBeNull();

    const retry = deferred<BaselineDetail | null>();
    api.loads.push(() => retry.promise);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(within(await screen.findByRole('status')).getByText('Loading')).toBeDefined();
    expect(screen.queryByText(/^Couldn't load this baseline/)).toBeNull();

    retry.resolve(baselineDetail(baselineRecord()));
    await bodyReady();
    expect(api.getCalls).toEqual([ID, ID]);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('keeps offering Retry while the baseline still fails to load', async () => {
    const api = apiFor();
    api.loads.push(() => rejectWith(new Error('Database is locked')), () => rejectWith('IPC channel closed'));
    const { user } = renderModal(api);

    await screen.findByText("Couldn't load this baseline: Database is locked");
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    // A rejection that is not an Error is shown as-is.
    expect(await screen.findByText("Couldn't load this baseline: IPC channel closed")).toBeDefined();
    expect(screen.queryByText(/Database is locked/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await bodyReady();
    expect(api.getCalls).toHaveLength(3);
  });
});

describe('BaselineDetailModal — band summary', () => {
  it('shows both edges of the band, per day and per month', async () => {
    renderModal(apiFor());
    await bodyReady();

    const band = statValue('Band low / high');
    expect(band.textContent).toBe('$10.00 – $20.00/day');
    expect(band.nextElementSibling?.textContent).toBe('$300.00 – $600.00/mo');
  });

  it('follows the band the editor previews', async () => {
    const { user } = renderModal(apiFor());
    await bodyReady();

    await user.click(modeButton('Percentile'));
    // Over $10..$50: P10 of the non-zero days, P90 of all days.
    expect(statValue('Band low / high').textContent).toBe('$14.00 – $46.00/day');
  });

  it('shows a saved dollar override', async () => {
    renderModal(apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'absolute', lower: 12, upper: 30 } }) }))));
    await bodyReady();
    expect(statValue('Band low / high').textContent).toBe('$12.00 – $30.00/day');
  });
});

describe('BaselineDetailModal — band mode', () => {
  it('marks the active mode as pressed', async () => {
    const { user } = renderModal(apiFor());
    await bodyReady();

    expect(modeButton('Absolute $').getAttribute('aria-pressed')).toBe('true');
    expect(modeButton('Percentile').getAttribute('aria-pressed')).toBe('false');
    await user.click(modeButton('Percentile'));
    expect(modeButton('Absolute $').getAttribute('aria-pressed')).toBe('false');
    expect(modeButton('Percentile').getAttribute('aria-pressed')).toBe('true');
  });

  it('re-picking the active mode leaves the automated band out of a note save', async () => {
    const api = apiFor();
    const { user } = renderModal(api);
    await bodyReady();

    await user.click(modeButton('Absolute $'));
    expect(bandLabel('lower')).toBe('lower $10.00');
    expect(bandLabel('upper')).toBe('upper $20.00');
    expect(saveButton()).toHaveProperty('disabled', true);

    await saveNote(user, api, 'Checked with the DB team');
    expect(api.patches).toEqual([{ note: { text: 'Checked with the DB team' } }]);
  });

  it('re-picking Percentile keeps a saved percentile override', async () => {
    const api = apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'percentile', lower: 25, upper: 75 } }) })));
    const { user } = renderModal(api);
    await bodyReady();
    expect(bandLabel('lower')).toBe('lower P25 ($20.00)');
    expect(bandLabel('upper')).toBe('upper P75 ($40.00)');

    await user.click(modeButton('Percentile'));
    expect(bandLabel('lower')).toBe('lower P25 ($20.00)');
    expect(bandLabel('upper')).toBe('upper P75 ($40.00)');
    expect(saveButton()).toHaveProperty('disabled', true);

    await saveNote(user, api, 'Seasonal');
    expect(api.patches).toEqual([{ note: { text: 'Seasonal' } }]);
  });

  it('re-picking Absolute $ keeps a saved dollar override', async () => {
    const { user } = renderModal(apiFor(baselineDetail(baselineRecord({ spec: baselineSpec({ manualBand: { mode: 'absolute', lower: 12, upper: 30 } }) }))));
    await bodyReady();

    await user.click(modeButton('Absolute $'));
    expect(bandLabel('lower')).toBe('lower $12.00');
    expect(bandLabel('upper')).toBe('upper $30.00');
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('re-picking the active mode keeps the band being edited', async () => {
    const api = apiFor();
    const { user } = renderModal(api);
    await bodyReady();

    act(() => { screen.getByRole('slider', { name: 'Minimum' }).focus(); });
    // One slider step of $50 / 200.
    await user.keyboard('{ArrowRight}');
    await user.click(modeButton('Absolute $'));
    expect(bandLabel('lower')).toBe('lower $10.25');
    expect(saveButton()).toHaveProperty('disabled', false);

    await user.click(saveButton());
    await waitFor(() => { expect(api.patches).toHaveLength(1); });
    expect(api.patches).toEqual([{ manualBand: { mode: 'absolute', lower: 10.25, upper: 20 } }]);
  });

  it('saves a switch to the other mode', async () => {
    const api = apiFor();
    const { user } = renderModal(api);
    await bodyReady();

    await user.click(modeButton('Percentile'));
    expect(saveButton()).toHaveProperty('disabled', false);
    await user.click(saveButton());
    await waitFor(() => { expect(api.patches).toHaveLength(1); });
    expect(api.patches).toEqual([{ manualBand: { mode: 'percentile', lower: 10, upper: 90 } }]);
  });

  it('switching modes and back to the automated band leaves nothing to save', async () => {
    const api = apiFor();
    const { user } = renderModal(api);
    await bodyReady();

    await user.click(modeButton('Percentile'));
    await user.click(modeButton('Absolute $'));
    expect(bandLabel('lower')).toBe('lower $10.00');
    expect(bandLabel('upper')).toBe('upper $20.00');
    expect(saveButton()).toHaveProperty('disabled', true);

    await saveNote(user, api, 'Looked fine');
    expect(api.patches).toEqual([{ note: { text: 'Looked fine' } }]);
  });

  it('nudging an edge and back leaves nothing to save', async () => {
    const { user } = renderModal(apiFor());
    await bodyReady();

    act(() => { screen.getByRole('slider', { name: 'Minimum' }).focus(); });
    await user.keyboard('{ArrowRight}');
    expect(saveButton()).toHaveProperty('disabled', false);
    await user.keyboard('{ArrowLeft}');
    expect(bandLabel('lower')).toBe('lower $10.00');
    expect(saveButton()).toHaveProperty('disabled', true);
  });
});
