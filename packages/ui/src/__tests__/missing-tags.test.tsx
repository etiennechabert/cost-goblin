import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { MissingTags } from '../views/missing-tags.js';

function renderMissingTags() {
  const api = new MockCostApi();
  return {
    api,
    ...render(
      <CostApiProvider value={api}>
        <MissingTags />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('MissingTags', () => {
  it('shows table with resource data after loading', async () => {
    renderMissingTags();
    await waitFor(() => {
      expect(screen.getByText('Account')).toBeDefined();
      expect(screen.getByText('Resource')).toBeDefined();
      expect(screen.getByText('Service')).toBeDefined();
    });
  });

  it('has min cost filter input defaulting to 0', () => {
    renderMissingTags();
    expect(screen.getByDisplayValue('0')).toBeDefined();
  });
});
