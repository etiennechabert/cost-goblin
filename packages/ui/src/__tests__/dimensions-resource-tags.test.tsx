import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

afterEach(cleanup);

describe('DimensionsView — Resource Tags debug panel', () => {
  it('exposes the panel and badge toggle state to assistive tech', async () => {
    const user = userEvent.setup();
    render(
      <CostApiProvider value={new MockCostApi()}>
        <DimensionsView />
      </CostApiProvider>,
    );

    const toggle = await screen.findByRole('button', { name: /Resource Tags/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    const panel = toggle.parentElement;
    if (panel === null) throw new Error('panel toggle has no container');
    const badge = await within(panel).findByRole('button', { name: 'team' });
    expect(badge.getAttribute('aria-pressed')).toBe('true');
    expect(within(panel).getAllByRole('columnheader').map(th => th.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('team')]),
    );

    await user.click(badge);
    await waitFor(() => { expect(within(panel).getByRole('button', { name: 'team' }).getAttribute('aria-pressed')).toBe('false'); });
    expect(within(panel).getAllByRole('columnheader').map(th => th.textContent)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('team')]),
    );
  });
});
