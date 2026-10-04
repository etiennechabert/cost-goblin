import { asDimensionId } from '@costgoblin/core/browser';
import type { ViewSpec } from '@costgoblin/core/browser';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ViewYamlModal } from '../components/view-yaml-modal.js';

const VIEW: ViewSpec = {
  id: 'team-costs',
  name: 'Team costs',
  rows: [{ widgets: [{ id: 'w-pie', type: 'pie', size: 'medium', groupBy: asDimensionId('service') }] }],
};

describe('ViewYamlModal', () => {
  it('export mode is a modal dialog named "Export view" and described by its hint', () => {
    render(<ViewYamlModal mode="export" view={VIEW} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', {
      name: 'Export view',
      description: 'Copy this YAML to share or back up the view.',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('import mode is a modal dialog named "Import view" and described by its hint', () => {
    render(<ViewYamlModal mode="import" existingIds={new Set()} onImport={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', {
      name: 'Import view',
      description: 'Paste a view YAML (from Export) to add it.',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes from the Close button, Escape and the aria-hidden backdrop', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ViewYamlModal mode="export" view={VIEW} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Export view' });

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.keyboard('{Escape}');
    const backdrop = dialog.querySelector(':scope > [aria-hidden="true"]');
    if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not found');
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
