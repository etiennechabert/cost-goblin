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

  // The app re-renders on every sync poll, handing the modal a fresh props
  // object: that must not pull focus off the textarea mid-paste.
  it('keeps focus in the import textarea when a parent re-render passes new props', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ViewYamlModal mode="import" existingIds={new Set()} onImport={vi.fn()} onClose={() => undefined} />,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    const textarea = screen.getByRole('textbox');
    await user.click(textarea);

    const onClose = vi.fn();
    rerender(<ViewYamlModal mode="import" existingIds={new Set()} onImport={vi.fn()} onClose={onClose} />);
    expect(document.activeElement).toBe(textarea);
    // …and Escape reaches the latest handler.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('announces an import error', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    render(<ViewYamlModal mode="import" existingIds={new Set()} onImport={onImport} onClose={vi.fn()} />);
    await user.click(screen.getByRole('textbox'));
    await user.paste('- not\n- a view\n');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByRole('alert').textContent).not.toBe('');
    expect(onImport).not.toHaveBeenCalled();
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
