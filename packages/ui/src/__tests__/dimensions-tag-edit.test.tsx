import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { CostApi } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

afterEach(cleanup);

describe('DimensionsView — editing a tag dimension', () => {
  // The tag editor only manages some fields; saving an edit must keep the
  // ones it doesn't (the description the view shows under the tag, and the
  // separator), not rebuild the tag without them.
  it('keeps the description and separator of a tag it saves', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
      builtIn: [
        { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
        { name: asDimensionId('service'), label: 'AWS Service', field: 'service' },
      ],
      tags: [{ tagName: 'team', label: 'Team', description: 'Owning team', separator: '/' }],
    });
    // Spied through the CostApi interface so the calls carry its signature.
    const costApi: CostApi = api;
    const saveSpy = vi.spyOn(costApi, 'saveDimensionsConfig');
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <DimensionsView />
      </CostApiProvider>,
    );

    await user.click(await screen.findByRole('button', { name: /tag:team/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: /Apply & rebuild/i }));

    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(1); });
    const saved = saveSpy.mock.calls[0]?.[0];
    expect(saved?.tags[0]).toMatchObject({ tagName: 'team', label: 'Team', description: 'Owning team', separator: '/' });
  });
});
