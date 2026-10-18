import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
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
 *  text the way it takes pasted text, and is tidied once the edit is done. */

// Unsorted on purpose: the editor shows the rules sorted, so a rule that is
// only focused and left must not write that sorted text back as an edit.
const TEAM: TagDimension = {
  tagName: 'team',
  label: 'Team',
  aliases: { search: ['srch'], payments: ['pay'] },
};

type User = ReturnType<typeof userEvent.setup>;

function renderView() {
  // Typed as the interface so the spy carries saveDimensionsConfig's real
  // parameters (the mock's own override declares none).
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
    builtIn: [{ name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' }],
    tags: [TEAM],
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
  const rule = await screen.findByDisplayValue(text);
  if (!(rule instanceof HTMLInputElement)) throw new Error(`"${text}" is not an input`);
  return rule;
}

/** The rules' text, in the order the editor shows them. */
function shownRules(): string[] {
  return screen.getAllByDisplayValue(/^\w+:/).map(el => (el instanceof HTMLInputElement ? el.value : ''));
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

    await user.tab();
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

  it('tidies a rule once the edit is done', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await user.type(rule, ', ab, ');
    expect(rule.value).toBe('payments: pay, ab, ');

    await user.keyboard('{Enter}');
    expect(shownRules()).toEqual(['payments: ab, pay', 'search: srch']);
  });

  it('keeps a renamed rule in its row while it is typed, then sorts it', async () => {
    const { saveSpy, user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await user.type(rule, 'zeta', { initialSelectionStart: 0, initialSelectionEnd: 'payments'.length });
    expect(rule.value).toBe('zeta: pay');
    expect(document.activeElement).toBe(rule);
    expect(shownRules()).toEqual(['zeta: pay', 'search: srch']);

    await user.tab();
    expect(shownRules()).toEqual(['search: srch', 'zeta: pay']);
    expect(await savedAliases(user, saveSpy)).toEqual({ zeta: ['pay'], search: ['srch'] });
  });

  it('adds a clicked preview value to the rule just edited, wherever it sorted to', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'payments: pay');
    await user.type(rule, 'zeta', { initialSelectionStart: 0, initialSelectionEnd: 'payments'.length });
    await user.tab();

    await user.click(await screen.findByRole('button', { name: 'platform' }));
    expect(shownRules()).toEqual(['search: srch', 'zeta: pay, platform']);
  });

  it('does not count focusing a rule and leaving it as an edit', async () => {
    const { user } = renderView();
    const rule = await openRule(user, 'search: srch');
    await user.click(rule);
    await user.tab();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?', hidden: true })).toBeNull();
    expect(screen.queryByDisplayValue('search: srch')).toBeNull();
  });
});
