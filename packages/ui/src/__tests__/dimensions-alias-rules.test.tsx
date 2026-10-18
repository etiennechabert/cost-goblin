import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { CostApi, TagDimension } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** Each alias rule is a one-line input. Tidying a rule (sorting it, dropping
 *  empty aliases) on every keystroke ate the ", " before the next alias could
 *  be typed, so typing ", PAY" after "payments: pay" gave "payments: payPAY",
 *  and renaming a rule remounted its input under the caret. A rule takes typed
 *  text the way it takes pasted text, and the rules are tidied once focus
 *  leaves them: nothing re-sorts while the user moves between rules. */

// Unsorted on purpose: the editor shows the rules sorted, so a rule that is
// only focused and left must not write that sorted text back as an edit.
const TEAM_ALIASES = { search: ['srch'], payments: ['pay'] };

type User = ReturnType<typeof userEvent.setup>;

function renderView(aliases: Readonly<Record<string, readonly string[]>> = TEAM_ALIASES) {
  // Typed as the interface so the spy carries saveDimensionsConfig's real
  // parameters (the mock's own override declares none).
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
    builtIn: [{ name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' }],
    tags: [{ tagName: 'team', label: 'Team', aliases }],
  });
  // The value preview under the rules shows one badge per sample value.
  vi.spyOn(api, 'discoverTagKeys').mockResolvedValue({
    tags: [{ key: 'team', sampleValues: ['platform'], rowCount: 10, distinctCount: 1, coveragePct: 100 }],
    samplePeriod: '2026-04',
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

/** Opens the Team editor and returns the input of the rule showing `text`. */
async function openRule(user: User, text: string): Promise<HTMLInputElement> {
  await user.click(await screen.findByRole('button', { name: /tag:team/ }));
  return ruleInput(await screen.findByDisplayValue(text));
}

function ruleInput(el: HTMLElement): HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) throw new Error('not an input');
  return el;
}

/** Selects the rule's name and types `name` over it. */
async function rename(user: User, rule: HTMLInputElement, name: string): Promise<void> {
  await user.type(rule, name, { initialSelectionStart: 0, initialSelectionEnd: rule.value.indexOf(':') });
}

/** Moves focus out of the rules, to the editor's label field. */
async function leaveRules(user: User): Promise<void> {
  await user.click(screen.getByPlaceholderText('e.g. Team'));
}

/** The rules' text (a name, then ':'), in the order the editor shows them. */
function shownRules(): string[] {
  return screen.getAllByDisplayValue(/^[^:\s][^:]*:/).map(el => ruleInput(el).value);
}

/** Saves the open editor, applies the draft, and returns the aliases persisted. */
async function savedAliases(user: User, saveSpy: ReturnType<typeof renderView>['saveSpy']): Promise<TagDimension['aliases']> {
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await user.click(await screen.findByRole('button', { name: /Apply & rebuild/i }));
  await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(1); });
  return saveSpy.mock.calls[0]?.[0].tags[0]?.aliases;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Tag editor — alias rules', () => {
  it.each([
    { how: 'typed', enter: (user: User, rule: HTMLInputElement) => user.type(rule, ', PAY') },
    {
      how: 'pasted',
      enter: async (user: User, rule: HTMLInputElement) => {
        await user.click(rule);
        await user.paste(', PAY');
      },
    },
  ])('takes a second alias $how after the first', async ({ enter }) => {
    const { saveSpy, user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await enter(user, rule);
    expect(rule.value).toBe('payments: pay, PAY');

    await leaveRules(user);
    expect(shownRules()).toEqual(['payments: pay, PAY', 'search: srch']);
    expect(await savedAliases(user, saveSpy)).toEqual({ payments: ['pay', 'PAY'], search: ['srch'] });
  });

  it('keeps a rule as typed while the window is away (switching apps to copy an alias)', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await user.type(rule, ', ');
    // A window blur: the input gets blur/focusout but stays the focused element.
    fireEvent.blur(rule);
    expect(document.activeElement).toBe(rule);
    expect(rule.value).toBe('payments: pay, ');

    await user.keyboard('PAY');
    expect(rule.value).toBe('payments: pay, PAY');
  });

  it('tidies a rule when Enter ends the edit', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await user.type(rule, ', ab, ');
    expect(rule.value).toBe('payments: pay, ab, ');

    await user.keyboard('{Enter}');
    expect(shownRules()).toEqual(['payments: ab, pay', 'search: srch']);
  });

  it('keeps a renamed rule in its row until focus leaves the rules, then sorts it', async () => {
    const { saveSpy, user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await rename(user, rule, 'zeta');
    expect(rule.value).toBe('zeta: pay');
    expect(document.activeElement).toBe(rule);
    expect(shownRules()).toEqual(['zeta: pay', 'search: srch']);

    // Tab reaches the rule's own remove button: still in the rules, still its row.
    await user.tab();
    expect(document.activeElement).toBe(within(rowOf(rule)).getByRole('button', { name: 'Remove rule' }));
    expect(shownRules()).toEqual(['zeta: pay', 'search: srch']);

    await leaveRules(user);
    expect(shownRules()).toEqual(['search: srch', 'zeta: pay']);
    expect(await savedAliases(user, saveSpy)).toEqual({ zeta: ['pay'], search: ['srch'] });
  });

  it('removes a rule with one click right after renaming it', async () => {
    const { saveSpy, user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await rename(user, rule, 'zeta');
    await user.click(within(rowOf(rule)).getByRole('button', { name: 'Remove rule' }));

    expect(shownRules()).toEqual(['search: srch']);
    expect(await savedAliases(user, saveSpy)).toEqual({ search: ['srch'] });
  });

  it('adds a clicked preview value to the rule just renamed, wherever it sorts to', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await rename(user, rule, 'zeta');

    await user.click(await screen.findByRole('button', { name: 'platform' }));
    expect(shownRules()).toEqual(['search: srch', 'zeta: pay, platform']);
  });

  it('adds a clicked preview value to the rule focused after another was renamed', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await rename(user, rule, 'zeta');
    await user.click(screen.getByDisplayValue('search: srch'));

    await user.click(await screen.findByRole('button', { name: 'platform' }));
    expect(shownRules()).toEqual(['search: platform, srch', 'zeta: pay']);
  });

  it('keeps the highlight on its rule when another rule is removed', async () => {
    const { user } = renderView({ alpha: ['a'], search: ['srch'], tango: ['t'] });
    const rule = await openRule(user, 'alpha: a');
    await rename(user, rule, 'zulu');
    // The rows are still as they were (zulu first); removing tango sorts the rest.
    await user.click(within(rowOf(screen.getByDisplayValue('tango: t'))).getByRole('button', { name: 'Remove rule' }));
    expect(shownRules()).toEqual(['search: srch', 'zulu: a']);

    await user.click(await screen.findByRole('button', { name: 'platform' }));
    expect(shownRules()).toEqual(['search: srch', 'zulu: a, platform']);
  });

  it('does not count focusing a rule and leaving it as an edit', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'search: srch');
    await user.click(rule);
    await leaveRules(user);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?', hidden: true })).toBeNull();
    expect(screen.queryByDisplayValue('search: srch')).toBeNull();
  });
});

/** The row holding a rule's input and its remove button. */
function rowOf(el: HTMLElement): HTMLElement {
  const row = el.parentElement;
  if (row === null) throw new Error('rule input has no row');
  return row;
}
