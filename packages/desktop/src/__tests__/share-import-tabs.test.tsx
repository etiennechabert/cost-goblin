import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CostApiProvider, MockCostApi } from '@costgoblin/ui';
import { ImportTab } from '../renderer/settings/import-tab.js';
import { ShareTab } from '../renderer/settings/share-tab.js';

describe('ImportTab', () => {
  it('applies a teammate bundle inline and reports back only once the user is done', async () => {
    const api = new MockCostApi();
    const apply = vi.spyOn(api, 'applyConfigBundle');
    const onApplied = vi.fn();
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <ImportTab onApplied={onApplied} />
      </CostApiProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Import configuration' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Choose bundle file…' }));
    await user.click(await screen.findByRole('button', { name: 'Apply configuration' }));

    expect(apply).toHaveBeenCalledOnce();
    expect(await screen.findByText('Configuration applied.')).toBeDefined();
    expect(onApplied).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onApplied).toHaveBeenCalledOnce();
  });
});

describe('ShareTab', () => {
  it('exports this configuration from the tab itself', async () => {
    const api = new MockCostApi();
    const exportBundle = vi.spyOn(api, 'exportConfigBundle');
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <ShareTab />
      </CostApiProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Share configuration' })).toBeDefined();
    expect(screen.getByText(/as a file, an S3 beacon, or peer-to-peer/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Export…' }));
    expect(exportBundle).toHaveBeenCalledOnce();
  });
});
