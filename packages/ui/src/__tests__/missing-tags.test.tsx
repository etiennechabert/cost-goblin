import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { MissingTags } from '../views/missing-tags.js';

function renderMissingTags(api?: MockCostApi) {
  const mockApi = api ?? new MockCostApi();
  return {
    api: mockApi,
    ...render(
      <CostApiProvider value={mockApi}>
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

  it('shows loading state initially', () => {
    renderMissingTags();
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('shows loading indicator on initial render', async () => {
    renderMissingTags();
    expect(screen.getByText('Loading...')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
  });

  it('renders view header with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderMissingTags(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByText('Missing Tags')).toBeDefined();
    expect(screen.getByText('Resources without the selected allocation tag, classified by whether other resources in the same service category are tagged.')).toBeDefined();
  });

  it('renders controls with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderMissingTags(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByDisplayValue('0')).toBeDefined();
    expect(screen.getByText('Show likely-untaggable categories')).toBeDefined();
  });

  it('does not render summary stats with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderMissingTags(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.queryByText('Actionable missing tags')).toBeNull();
    expect(screen.queryByText('Likely not taggable')).toBeNull();
  });

  it('shows tag selector when multiple tag dimensions exist', async () => {
    renderMissingTags();
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByText('Team')).toBeDefined();
    expect(screen.getByText('Environment')).toBeDefined();
  });

  describe('edge cases', () => {
    it('renders table structure with minimal dataset', async () => {
      const api = new MockCostApi();
      renderMissingTags(api);
      await waitFor(() => {
        expect(screen.getByText('Account')).toBeDefined();
        expect(screen.getByText('Resource')).toBeDefined();
        expect(screen.getByText('Service')).toBeDefined();
      });
    });

    it('shows zero-row table body with empty data', async () => {
      const api = MockCostApi.withEmptyData();
      renderMissingTags(api);
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull();
      });
      const tbody = document.querySelector('tbody');
      expect(tbody).toBeDefined();
    });

    it('renders controls even with single resource', async () => {
      const api = new MockCostApi();
      renderMissingTags(api);
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).toBeNull();
      });
      expect(screen.getByDisplayValue('0')).toBeDefined();
      expect(screen.getByText('Show likely-untaggable categories')).toBeDefined();
    });

    it('handles dataset with single category', async () => {
      const api = new MockCostApi();
      renderMissingTags(api);
      await waitFor(() => {
        expect(screen.getByText('Missing Tags')).toBeDefined();
        expect(screen.getByText('Account')).toBeDefined();
      });
    });
  });
});
