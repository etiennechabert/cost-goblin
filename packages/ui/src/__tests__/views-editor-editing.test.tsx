import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { OVERVIEW_SEED_VIEW, SEED_VIEWS_CONFIG } from '@costgoblin/core/browser';
import type { Dimension, ViewSpec, ViewsConfig } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ViewsEditor } from '../views/views-editor.js';

/** A built-in view with a single light widget, so the preview stays cheap. */
const BUILT_IN: ViewSpec = {
  id: 'overview',
  name: 'Overview (edited)',
  builtIn: true,
  rows: [{ widgets: [{ id: 'o-total', type: 'summary', size: 'small', metric: 'total' }] }],
};

/** Two rows of summary widgets: enough to exercise every row/widget move. */
const TEAM: ViewSpec = {
  id: 'team',
  name: 'Team view',
  rows: [
    {
      widgets: [
        { id: 'w-total', type: 'summary', size: 'small', metric: 'total' },
        { id: 'w-delta', type: 'summary', size: 'small', metric: 'delta' },
      ],
    },
    { widgets: [{ id: 'w-count', type: 'summary', size: 'medium', metric: 'entityCount' }] },
  ],
};

const OTHER: ViewSpec = {
  id: 'other',
  name: 'Other view',
  rows: [{ widgets: [{ id: 'x-total', type: 'summary', size: 'small' }] }],
};

const CONFIG: ViewsConfig = { views: [BUILT_IN, TEAM, OTHER] };

class EditorApi extends MockCostApi {
  constructor(private readonly config: ViewsConfig = CONFIG) {
    super();
  }

  override getViewsConfig(): Promise<ViewsConfig> {
    return Promise.resolve(this.config);
  }

  /** Every config the editor persisted, oldest first. Declaring the
   *  parameter (the base mock takes none) also types a spy's recorded calls. */
  readonly saved: ViewsConfig[] = [];

  override saveViewsConfig(config?: ViewsConfig): Promise<void> {
    if (config !== undefined) this.saved.push(config);
    return super.saveViewsConfig();
  }
}

type SaveSpy = MockInstance<(config?: ViewsConfig) => Promise<void>>;

function renderEditor(api: EditorApi = new EditorApi(), onConfigPersisted?: (cfg: ViewsConfig) => void) {
  const user = userEvent.setup();
  const saveSpy = vi.spyOn(api, 'saveViewsConfig');
  return {
    api,
    user,
    saveSpy,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <ViewsEditor onConfigPersisted={onConfigPersisted} />
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

/** The config handed to the most recent saveViewsConfig call. */
function lastSaved(saveSpy: SaveSpy): ViewsConfig {
  const cfg = saveSpy.mock.calls.at(-1)?.[0];
  if (cfg === undefined) throw new Error('saveViewsConfig was never called');
  return cfg;
}

/** The i-th element, failing loudly instead of handing back `undefined`. */
function nth<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`expected at least ${String(i + 1)} matches, got ${String(items.length)}`);
  return item;
}

function savedView(cfg: ViewsConfig, id: string): ViewSpec {
  const view = cfg.views.find(v => v.id === id);
  if (view === undefined) throw new Error(`view ${id} not in saved config`);
  return view;
}

function widgetIds(view: ViewSpec): string[][] {
  return view.rows.map(r => r.widgets.map(w => w.id));
}

/** Names in the left-hand view list, in order. */
function listedViewNames(): string[] {
  return screen.getAllByRole('button', { name: /^Move view up$/ }).map((up) => {
    const row = up.parentElement?.parentElement;
    const nameButton = row?.querySelector('button');
    return nameButton?.firstChild?.textContent ?? '';
  });
}

async function selectView(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(await screen.findByRole('button', { name }));
  await screen.findByDisplayValue(name);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ViewsEditor — editing a view', () => {
  it('selects the first view on load and marks built-ins', async () => {
    renderEditor();
    expect(await screen.findByDisplayValue('Overview (edited)')).toBeDefined();
    expect(screen.getByRole('button', { name: /^Overview \(edited\)\s*built-in$/ })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Saved' })).toHaveProperty('disabled', true);
  });

  it('renames the selected view, then saves and reports the persisted config', async () => {
    const onConfigPersisted = vi.fn<(cfg: ViewsConfig) => void>();
    const { user, saveSpy } = renderEditor(new EditorApi(), onConfigPersisted);
    await selectView(user, 'Team view');

    const name = screen.getByDisplayValue('Team view');
    await user.clear(name);
    await user.type(name, 'Platform costs');
    expect(screen.getByRole('button', { name: 'Platform costs' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('button', { name: 'Saved' });

    const saved = lastSaved(saveSpy);
    expect(savedView(saved, 'team').name).toBe('Platform costs');
    // The other views are untouched.
    expect(savedView(saved, 'other')).toEqual(OTHER);
    expect(onConfigPersisted).toHaveBeenCalledWith(saved);
  });

  it('reorders views, keeping the first-up and last-down buttons disabled', async () => {
    const { user, saveSpy } = renderEditor();
    await screen.findByDisplayValue('Overview (edited)');

    const ups = screen.getAllByRole('button', { name: 'Move view up' });
    const downs = screen.getAllByRole('button', { name: 'Move view down' });
    expect(ups[0]).toHaveProperty('disabled', true);
    expect(downs[2]).toHaveProperty('disabled', true);

    await user.click(nth(downs, 0));
    expect(listedViewNames()).toEqual(['Team view', 'Overview (edited)', 'Other view']);

    await user.click(nth(screen.getAllByRole('button', { name: 'Move view up' }), 2));
    expect(listedViewNames()).toEqual(['Team view', 'Other view', 'Overview (edited)']);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });
    expect(lastSaved(saveSpy).views.map(v => v.id)).toEqual(['team', 'other', 'overview']);
  });

  it('deletes custom views only, and falls back to the first remaining view', async () => {
    const { user } = renderEditor();
    await selectView(user, 'Team view');

    // One delete button per custom view; the built-in has none.
    const deletes = screen.getAllByRole('button', { name: 'Delete view' });
    expect(deletes).toHaveLength(2);
    await user.click(nth(deletes, 0));

    expect(screen.queryByRole('button', { name: 'Team view' })).toBeNull();
    expect(await screen.findByDisplayValue('Overview (edited)')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
  });

  it('shows the empty state once the last view is deleted, and Export is disabled', async () => {
    const { user } = renderEditor(new EditorApi({ views: [OTHER] }));
    await screen.findByDisplayValue('Other view');

    await user.click(screen.getByRole('button', { name: 'Delete view' }));

    expect(await screen.findByText('Pick a view on the left, or create a new one.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Export' })).toHaveProperty('disabled', true);
  });

  it('starts empty when there are no views, and "+ New view" creates and selects one', async () => {
    const { user, saveSpy } = renderEditor(new EditorApi({ views: [] }));
    expect(await screen.findByText('Pick a view on the left, or create a new one.')).toBeDefined();

    await user.click(screen.getByRole('button', { name: '+ New view' }));
    expect(await screen.findByDisplayValue('New view')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });
    const [created] = lastSaved(saveSpy).views;
    expect(created?.name).toBe('New view');
    expect(created?.rows[0]?.widgets[0]?.type).toBe('summary');
  });
});

describe('ViewsEditor — rows and widgets', () => {
  it('moves, adds and deletes rows', async () => {
    const { user, saveSpy } = renderEditor();
    await selectView(user, 'Team view');

    const rowDowns = screen.getAllByRole('button', { name: 'Move row down' });
    expect(screen.getAllByRole('button', { name: 'Move row up' })[0]).toHaveProperty('disabled', true);
    expect(rowDowns[1]).toHaveProperty('disabled', true);

    await user.click(nth(rowDowns, 0));

    await user.click(screen.getByRole('button', { name: '+ Add row' }));
    expect(screen.getByText('Row 3')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });
    const afterAdd = savedView(lastSaved(saveSpy), 'team');
    expect(widgetIds(afterAdd).slice(0, 2)).toEqual([['w-count'], ['w-total', 'w-delta']]);
    // The new row holds one pie, grouped by the first configured dimension.
    expect(afterAdd.rows[2]?.widgets).toEqual([
      expect.objectContaining({ type: 'pie', size: 'medium', groupBy: 'provider' }),
    ]);

    // Move the new row back up, then delete the (now) first row.
    await user.click(nth(screen.getAllByRole('button', { name: 'Move row up' }), 2));
    await user.click(nth(screen.getAllByRole('button', { name: 'Delete row' }), 0));
    expect(screen.queryByText('Row 3')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(2); });
    const afterDelete = savedView(lastSaved(saveSpy), 'team');
    expect(afterDelete.rows).toHaveLength(2);
    expect(afterDelete.rows[0]?.widgets[0]?.type).toBe('pie');
    expect(widgetIds(afterDelete)[1]).toEqual(['w-total', 'w-delta']);
  });

  it('falls back to the service dimension for new widgets when no dimensions load', async () => {
    class NoDimsApi extends EditorApi {
      override getDimensions(): Promise<Dimension[]> {
        return Promise.resolve([]);
      }
    }
    const { user, saveSpy } = renderEditor(new NoDimsApi());
    await selectView(user, 'Team view');

    await user.click(screen.getByRole('button', { name: '+ Add row' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });
    expect(savedView(lastSaved(saveSpy), 'team').rows[2]?.widgets[0]).toEqual(
      expect.objectContaining({ type: 'pie', groupBy: 'service' }),
    );
  });

  it('adds, reorders, resizes, retypes and removes widgets within their row', async () => {
    const { user, saveSpy } = renderEditor();
    await selectView(user, 'Team view');

    // Only a widget with a neighbour gets the matching move arrow.
    expect(screen.getAllByRole('button', { name: 'Move widget right' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Move widget left' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Move widget right' }));
    // Resize the widget now in the first slot (w-delta) to large.
    await user.click(nth(screen.getAllByRole('button', { name: 'L' }), 0));

    // Add a widget to the second row, then retype that row's original widget.
    await user.click(nth(screen.getAllByRole('button', { name: '+ Widget' }), 1));
    // Type pickers in document order: w-delta, w-total, w-count, then the new pie.
    await user.selectOptions(nth(screen.getAllByRole('combobox'), 2), 'burndown');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });
    const edited = savedView(lastSaved(saveSpy), 'team');
    expect(widgetIds(edited)[0]).toEqual(['w-delta', 'w-total']);
    expect(edited.rows[0]?.widgets[0]?.size).toBe('large');
    expect(edited.rows[1]?.widgets[0]).toEqual(expect.objectContaining({ id: 'w-count', type: 'burndown' }));
    expect(edited.rows[1]?.widgets[1]).toEqual(expect.objectContaining({ type: 'pie', groupBy: 'provider' }));

    // Move w-total back left.
    await user.click(nth(screen.getAllByRole('button', { name: 'Move widget left' }), 0));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(2); });
    expect(widgetIds(savedView(lastSaved(saveSpy), 'team'))[0]).toEqual(['w-total', 'w-delta']);

    // Then empty the first row entirely.
    const removes = screen.getAllByRole('button', { name: 'Remove widget' });
    expect(removes).toHaveLength(4);
    await user.click(nth(removes, 0));
    await user.click(nth(screen.getAllByRole('button', { name: 'Remove widget' }), 0));

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(3); });
    const emptied = savedView(lastSaved(saveSpy), 'team');
    expect(emptied.rows[0]?.widgets).toEqual([]);
    expect(emptied.rows[1]?.widgets.map(w => w.id)[0]).toBe('w-count');
    // The emptied row is still editable: it keeps its own "+ Widget".
    expect(screen.getByText('Row 1')).toBeDefined();
    expect(screen.getAllByRole('button', { name: '+ Widget' })).toHaveLength(2);
  });
});

describe('ViewsEditor — header actions', () => {
  it('reveals the views folder, swallowing a failure', async () => {
    const api = new EditorApi();
    const reveal = vi.spyOn(api, 'revealViewsFolder').mockRejectedValue(new Error('no Finder'));
    const { user } = renderEditor(api);
    await screen.findByDisplayValue('Overview (edited)');

    await user.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(reveal).toHaveBeenCalledOnce();
    expect(screen.queryByText('no Finder')).toBeNull();
  });

  it('exports the selected view as YAML', async () => {
    const { user } = renderEditor();
    await selectView(user, 'Team view');

    await user.click(screen.getByRole('button', { name: 'Export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export view' });
    const yaml = within(dialog).getByRole('textbox');
    expect(yaml).toHaveProperty('value', expect.stringContaining('name: Team view'));

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('imports a pasted view as a new, selected, unsaved view', async () => {
    const { user, saveSpy } = renderEditor();
    await screen.findByDisplayValue('Overview (edited)');

    await user.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import view' });
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste([
      'id: imported',
      'name: Imported view',
      'rows:',
      '  - widgets:',
      '      - id: imp-1',
      '        type: summary',
      '        size: small',
    ].join('\n'));
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(await screen.findByDisplayValue('Imported view')).toBeDefined();
    expect(saveSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });
    expect(lastSaved(saveSpy).views.map(v => v.id)).toEqual(['overview', 'team', 'other', 'imported']);
  });

  it('refuses to import a view whose id already exists', async () => {
    const { user } = renderEditor();
    await screen.findByDisplayValue('Overview (edited)');

    await user.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = await screen.findByRole('dialog', { name: 'Import view' });
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste('id: team\nname: Copy\nrows: []\n');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    expect(within(dialog).getByRole('alert').textContent).toContain('A view with id "team" already exists');

    // Closing without importing leaves the config untouched.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.getByRole('button', { name: 'Saved' })).toHaveProperty('disabled', true);
  });

  it('shows "Saving…" and locks the header while a save is in flight', async () => {
    const api = new EditorApi();
    let release: (() => void) | undefined;
    const { user, saveSpy } = renderEditor(api);
    saveSpy.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    await screen.findByDisplayValue('Overview (edited)');

    await user.click(screen.getByRole('button', { name: '+ New view' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toHaveProperty('disabled', true);
    for (const label of ['Import', 'Export', 'Reset built-ins']) {
      expect(screen.getByRole('button', { name: label })).toHaveProperty('disabled', true);
    }

    release?.();
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', false);
  });

  it('surfaces a non-Error save rejection as text', async () => {
    const { user, saveSpy } = renderEditor();
    saveSpy.mockRejectedValue('disk full');
    await screen.findByDisplayValue('Overview (edited)');

    await user.click(screen.getByRole('button', { name: '+ New view' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('disk full')).toBeDefined();
    // The edit is still pending, so it can be retried.
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
  });

  it('surfaces a non-Error load rejection as text', async () => {
    const api = new EditorApi();
    vi.spyOn(api, 'getViewsConfig').mockRejectedValue('views.yaml unreadable');
    renderEditor(api);
    expect(await screen.findByText('views.yaml unreadable')).toBeDefined();
  });

  it('ignores a late answer from an API it has already switched away from', async () => {
    // The first API (e.g. the workspace before a switch) answers only after
    // the editor has moved on to the next one.
    let resolveStale: ((cfg: ViewsConfig) => void) | undefined;
    let rejectStale: ((err: Error) => void) | undefined;
    class SlowApi extends MockCostApi {
      override getViewsConfig(): Promise<ViewsConfig> {
        return new Promise((resolve) => { resolveStale = resolve; });
      }
    }
    class SlowFailingApi extends MockCostApi {
      override getViewsConfig(): Promise<ViewsConfig> {
        return new Promise((_resolve, reject) => { rejectStale = reject; });
      }
    }
    const current = new EditorApi({ views: [OTHER] });
    const tree = (api: MockCostApi) => (
      <PaletteProvider>
        <CostApiProvider value={api}>
          <ViewsEditor />
        </CostApiProvider>
      </PaletteProvider>
    );
    const { rerender } = render(tree(new SlowApi()));
    rerender(tree(new SlowFailingApi()));
    rerender(tree(current));
    await screen.findByDisplayValue('Other view');

    resolveStale?.({ views: [TEAM] });
    rejectStale?.(new Error('stale failure'));
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    expect(screen.getByDisplayValue('Other view')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Team view' })).toBeNull();
    expect(screen.queryByText('stale failure')).toBeNull();
  });
});

describe('ViewsEditor — Reset built-ins', () => {
  const seedIdsExceptOverview = SEED_VIEWS_CONFIG.views
    .filter(v => v.builtIn === true && v.id !== 'overview')
    .map(v => v.id);

  it('does nothing when the confirmation is cancelled', async () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const { user, saveSpy } = renderEditor();
    await screen.findByDisplayValue('Overview (edited)');

    await user.click(screen.getByRole('button', { name: 'Reset built-ins' }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Overview \(edited\)\s*built-in$/ })).toBeDefined();
  });

  it('restores seed built-ins, keeps custom views and the selection, and persists', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const onConfigPersisted = vi.fn<(cfg: ViewsConfig) => void>();
    const { user, saveSpy } = renderEditor(new EditorApi(), onConfigPersisted);
    await selectView(user, 'Other view');

    await user.click(screen.getByRole('button', { name: 'Reset built-ins' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });

    const saved = lastSaved(saveSpy);
    // Missing seed built-ins are prepended; the edited built-in is replaced
    // in place by its seed; custom views stay where they were.
    expect(saved.views.map(v => v.id)).toEqual([...seedIdsExceptOverview, 'overview', 'team', 'other']);
    expect(savedView(saved, 'overview')).toEqual(OVERVIEW_SEED_VIEW);
    expect(savedView(saved, 'team')).toEqual(TEAM);
    expect(onConfigPersisted).toHaveBeenCalledWith(saved);

    expect(await screen.findByRole('button', { name: /^Cost Overview\s*built-in$/ })).toBeDefined();
    expect(screen.getByDisplayValue('Other view')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Saved' })).toBeDefined();
  });

  it('selects the first seed view when nothing was selected', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const { user, saveSpy } = renderEditor(new EditorApi({ views: [] }));
    await screen.findByText('Pick a view on the left, or create a new one.');

    await user.click(screen.getByRole('button', { name: 'Reset built-ins' }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledOnce(); });

    expect(lastSaved(saveSpy).views.map(v => v.id)).toEqual(
      SEED_VIEWS_CONFIG.views.filter(v => v.builtIn === true).map(v => v.id),
    );
    expect(await screen.findByDisplayValue('Cost Overview')).toBeDefined();
  });

  it.each([
    { rejection: new Error('EROFS: read-only file system'), shown: 'EROFS: read-only file system' },
    { rejection: 'quota exceeded', shown: 'quota exceeded' },
  ])('shows "$shown" and keeps the current views when the reset save fails', async ({ rejection, shown }) => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const { user, saveSpy } = renderEditor();
    saveSpy.mockRejectedValue(rejection);
    await screen.findByDisplayValue('Overview (edited)');

    await user.click(screen.getByRole('button', { name: 'Reset built-ins' }));

    expect(await screen.findByText(shown)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Overview \(edited\)\s*built-in$/ })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reset built-ins' })).toHaveProperty('disabled', false);
  });
});
