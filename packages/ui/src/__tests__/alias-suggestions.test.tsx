import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AliasSuggestion, CostApi } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { AliasSuggestions } from '../components/alias-suggestions.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { deferred } from './deferred.js';

/** The "Suggested Aliases" disclosure under a dimension editor: near-duplicate
 *  values the backend proposes merging. Each can be flipped (pick another value
 *  as the canonical one), accepted (persisted, then handed to the editor) or
 *  dismissed (faded out, then persisted as "don't suggest again"). */

const PROD: AliasSuggestion = { canonical: 'prod', aliases: ['production', 'PROD'] };
const STAGING: AliasSuggestion = { canonical: 'staging', aliases: ['stage'] };

type OnAccepted = (canonical: string, aliases: readonly string[]) => void;

function makeApi(suggestions: AliasSuggestion[] = [PROD, STAGING]): CostApi {
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getAliasSuggestions').mockResolvedValue(suggestions);
  return api;
}

/** An api whose suggestions depend on the dimension asked about. */
function makeApiBy(byDimension: Readonly<Record<string, AliasSuggestion[]>>) {
  const api: CostApi = new MockCostApi();
  const getSuggestions = vi.spyOn(api, 'getAliasSuggestions').mockImplementation((dimensionId) => Promise.resolve(byDimension[dimensionId] ?? []));
  return { api, getSuggestions };
}

function Suggestions({ api, dimensionId, onAccepted }: Readonly<{ api: CostApi; dimensionId: string; onAccepted: OnAccepted | undefined }>): React.JSX.Element {
  return (
    <CostApiProvider value={api}>
      <AliasSuggestions dimensionId={dimensionId} {...(onAccepted === undefined ? {} : { onAccepted })} />
    </CostApiProvider>
  );
}

function renderSuggestions(api: CostApi, onAccepted?: OnAccepted) {
  const user = userEvent.setup();
  const view = render(<Suggestions api={api} dimensionId="env" onAccepted={onAccepted} />);
  return {
    user,
    rerender: (dimensionId: string) => { view.rerender(<Suggestions api={api} dimensionId={dimensionId} onAccepted={onAccepted} />); },
  };
}

/** Opens the disclosure once the suggestions have loaded. */
async function expand(user: ReturnType<typeof userEvent.setup>, count: number): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Suggested Aliases (${String(count)})` }));
}

function actionButton(action: 'Flip' | 'Accept' | 'Dismiss', canonical: string): HTMLElement {
  return screen.getByRole('button', { name: `${action} alias suggestion for ${canonical}` });
}

/** The card holding one suggestion: Accept sits in its button row. */
function cardOf(canonical: string): HTMLElement {
  const card = actionButton('Accept', canonical).parentElement?.parentElement;
  if (card === null || card === undefined) throw new Error(`no card for ${canonical}`);
  return card;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('AliasSuggestions', () => {
  it('asks for the dimension\'s suggestions and shows a collapsed count', async () => {
    const { api, getSuggestions } = makeApiBy({ env: [PROD, STAGING] });
    renderSuggestions(api);
    expect(await screen.findByRole('button', { name: 'Suggested Aliases (2)' })).toBeDefined();
    expect(getSuggestions).toHaveBeenCalledWith('env');
    // Collapsed: no suggestion is listed yet.
    expect(screen.queryByText('prod')).toBeNull();
  });

  it('expands to list each proposed merge, and collapses again', async () => {
    const { user } = renderSuggestions(makeApi());
    await expand(user, 2);
    expect(screen.getByText('prod')).toBeDefined();
    expect(screen.getByText('Merge: production, PROD')).toBeDefined();
    expect(screen.getByText('staging')).toBeDefined();
    expect(screen.getByText('Merge: stage')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Suggested Aliases (2)' }));
    expect(screen.queryByText('prod')).toBeNull();
  });

  it('renders nothing for a dimension with no suggestions', async () => {
    const { api, getSuggestions } = makeApiBy({ env: [PROD] });
    const { rerender } = renderSuggestions(api);
    expect(await screen.findByRole('button', { name: 'Suggested Aliases (1)' })).toBeDefined();

    rerender('owner');
    await waitFor(() => { expect(getSuggestions).toHaveBeenLastCalledWith('owner'); });
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0); }); });
    expect(screen.queryByRole('button', { name: /Suggested Aliases/ })).toBeNull();
  });

  it('flips which value is the canonical one, cycling through the merged values', async () => {
    const { user } = renderSuggestions(makeApi());
    await expand(user, 2);

    await user.click(actionButton('Flip', 'prod'));
    expect(screen.getByText('production')).toBeDefined();
    expect(screen.getByText('Merge: PROD, prod')).toBeDefined();

    await user.click(actionButton('Flip', 'production'));
    expect(screen.getByText('PROD')).toBeDefined();
    expect(screen.getByText('Merge: prod, production')).toBeDefined();
    // The other suggestion is untouched.
    expect(screen.getByText('Merge: stage')).toBeDefined();
  });

  it('leaves a suggestion with nothing to merge as it is when flipped', async () => {
    const { user } = renderSuggestions(makeApi([{ canonical: 'solo', aliases: [] }]));
    await expand(user, 1);
    await user.click(actionButton('Flip', 'solo'));
    expect(screen.getByText('solo')).toBeDefined();
    expect(actionButton('Accept', 'solo')).toBeDefined();
  });

  it('accepting persists the merge, removes it and hands it to the editor', async () => {
    const api = makeApi();
    const accept = vi.spyOn(api, 'acceptSuggestion');
    const onAccepted = vi.fn<OnAccepted>();
    const { user } = renderSuggestions(api, onAccepted);
    await expand(user, 2);

    await user.click(actionButton('Accept', 'prod'));
    await waitFor(() => { expect(screen.queryByText('prod')).toBeNull(); });
    expect(accept).toHaveBeenCalledWith('env', 'prod', ['production', 'PROD']);
    expect(onAccepted).toHaveBeenCalledWith('prod', ['production', 'PROD']);
    expect(screen.getByRole('button', { name: 'Suggested Aliases (1)' })).toBeDefined();
  });

  it('accepts the canonical value the user flipped to', async () => {
    const api = makeApi();
    const accept = vi.spyOn(api, 'acceptSuggestion');
    const onAccepted = vi.fn<OnAccepted>();
    const { user } = renderSuggestions(api, onAccepted);
    await expand(user, 2);

    await user.click(actionButton('Flip', 'staging'));
    await user.click(actionButton('Accept', 'stage'));
    await waitFor(() => { expect(onAccepted).toHaveBeenCalledWith('stage', ['staging']); });
    expect(accept).toHaveBeenCalledWith('env', 'stage', ['staging']);
  });

  it('still removes an accepted suggestion when nothing listens for it', async () => {
    const api = makeApi();
    const accept = vi.spyOn(api, 'acceptSuggestion');
    const { user } = renderSuggestions(api);
    await expand(user, 2);

    await user.click(actionButton('Accept', 'staging'));
    await waitFor(() => { expect(screen.queryByText('staging')).toBeNull(); });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('disables a suggestion\'s actions while its accept is in flight, and only that one\'s', async () => {
    const api = makeApi();
    const pending = deferred<undefined>();
    vi.spyOn(api, 'acceptSuggestion').mockReturnValue(pending.promise);
    const { user } = renderSuggestions(api);
    await expand(user, 2);

    await user.click(actionButton('Accept', 'prod'));
    for (const action of ['Flip', 'Accept', 'Dismiss'] as const) {
      expect(actionButton(action, 'prod')).toHaveProperty('disabled', true);
      expect(actionButton(action, 'staging')).toHaveProperty('disabled', false);
    }

    await act(async () => { pending.resolve(undefined); await pending.promise; });
    await waitFor(() => { expect(screen.queryByText('prod')).toBeNull(); });
    expect(actionButton('Accept', 'staging')).toHaveProperty('disabled', false);
  });

  it('dismissing fades the suggestion out, then persists the dismissal and removes it', async () => {
    const api = makeApi();
    const dismiss = vi.spyOn(api, 'dismissSuggestion');
    const { user } = renderSuggestions(api);
    await expand(user, 2);
    expect(cardOf('staging').className).toContain('opacity-100');

    await user.click(actionButton('Dismiss', 'staging'));
    // The fade starts at once; the dismissal is only sent once it has played.
    expect(cardOf('staging').className).toContain('opacity-0');
    expect(dismiss).not.toHaveBeenCalled();

    await waitFor(() => { expect(screen.queryByText('staging')).toBeNull(); });
    expect(dismiss).toHaveBeenCalledWith('env', 'staging', ['stage']);
    expect(screen.getByRole('button', { name: 'Suggested Aliases (1)' })).toBeDefined();
  });

  it('brings a suggestion back when its dismissal fails', async () => {
    const api = makeApi();
    const pending = deferred<undefined>();
    const dismiss = vi.spyOn(api, 'dismissSuggestion').mockReturnValue(pending.promise);
    const { user } = renderSuggestions(api);
    await expand(user, 2);

    await user.click(actionButton('Dismiss', 'prod'));
    // While the dismissal is being sent, its actions are disabled.
    await waitFor(() => { expect(dismiss).toHaveBeenCalledWith('env', 'prod', ['production', 'PROD']); });
    expect(actionButton('Dismiss', 'prod')).toHaveProperty('disabled', true);

    await act(async () => { pending.reject(new Error('disk full')); await pending.promise.catch(() => undefined); });
    await waitFor(() => { expect(actionButton('Dismiss', 'prod')).toHaveProperty('disabled', false); });
    expect(cardOf('prod').className).toContain('opacity-100');
    expect(screen.getByRole('button', { name: 'Suggested Aliases (2)' })).toBeDefined();
  });
});
