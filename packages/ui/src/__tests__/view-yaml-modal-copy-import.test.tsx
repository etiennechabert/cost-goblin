import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { ViewSpec } from '@costgoblin/core/browser';
import { ViewYamlModal } from '../components/view-yaml-modal.js';

const BUILT_IN_WITH_ICON: ViewSpec = {
  id: 'overview',
  name: 'Cost Overview',
  icon: 'chart',
  builtIn: true,
  rows: [{ widgets: [{ id: 'w-pie', type: 'pie', size: 'medium', groupBy: asDimensionId('service') }] }],
};

const VIEW_YAML = [
  'id: imported',
  'name: Imported',
  'icon: star',
  'builtIn: true',
  'rows:',
  '  - widgets:',
  '      - id: imp-total',
  '        type: summary',
  '        size: small',
].join('\n');

function renderImport(existingIds: readonly string[] = []) {
  const onImport = vi.fn<(view: ViewSpec) => void>();
  const user = userEvent.setup();
  render(<ViewYamlModal mode="import" existingIds={new Set(existingIds)} onImport={onImport} onClose={vi.fn()} />);
  return { onImport, user };
}

async function pasteAndImport(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(screen.getByRole('textbox'));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Import' }));
}

describe('ViewYamlModal — export', () => {
  it('exports a built-in as a custom view, keeping its icon', () => {
    render(<ViewYamlModal mode="export" view={BUILT_IN_WITH_ICON} onClose={vi.fn()} />);
    const yaml = screen.getByRole('textbox');
    expect(yaml).toHaveProperty('readOnly', true);
    const text = yaml instanceof HTMLTextAreaElement ? yaml.value : '';
    expect(text).toContain('id: overview');
    expect(text).toContain('icon: chart');
    expect(text).not.toContain('builtIn');
  });

  it('copies the YAML and briefly confirms it', async () => {
    const user = userEvent.setup();
    render(<ViewYamlModal mode="export" view={BUILT_IN_WITH_ICON} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await navigator.clipboard.readText()).toContain('name: Cost Overview');
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeDefined();
    // The confirmation reverts on its own after a moment.
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined(); }, { timeout: 3000 });
  });
});

describe('ViewYamlModal — import', () => {
  it('keeps Import disabled until something other than whitespace is pasted', async () => {
    const { user } = renderImport();
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('textbox'));
    await user.paste('   \n');
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', true);
    await user.paste('id: x');
    expect(screen.getByRole('button', { name: 'Import' })).toHaveProperty('disabled', false);
  });

  it('imports a single view as a custom one, keeping its icon', async () => {
    const { onImport, user } = renderImport();
    await pasteAndImport(user, VIEW_YAML);

    expect(onImport).toHaveBeenCalledWith({
      id: 'imported',
      name: 'Imported',
      icon: 'star',
      rows: [{ widgets: [{ id: 'imp-total', type: 'summary', size: 'small' }] }],
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('imports the first view of a pasted { views: [...] } config', async () => {
    const { onImport, user } = renderImport();
    await pasteAndImport(user, ['views:', ...VIEW_YAML.split('\n').map((line, i) => (i === 0 ? `  - ${line}` : `    ${line}`))].join('\n'));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onImport.mock.calls[0]?.[0].id).toBe('imported');
  });

  it.each([
    { pasted: 'views: []', shown: 'No view found in pasted text.' },
    { pasted: 'just a sentence', shown: 'views config must be an object' },
    { pasted: 'null', shown: 'views config must be an object' },
    { pasted: 'id: [unclosed', shown: 'Flow sequence' },
  ])('explains why "$pasted" cannot be imported', async ({ pasted, shown }) => {
    const { onImport, user } = renderImport();
    await pasteAndImport(user, pasted);
    expect(screen.getByRole('alert').textContent).toContain(shown);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('refuses a view whose id is already taken, and clears the error once the text changes', async () => {
    const { onImport, user } = renderImport(['imported']);
    await pasteAndImport(user, VIEW_YAML);

    expect(screen.getByRole('alert').textContent).toBe(
      'A view with id "imported" already exists. Rename it in the YAML before importing.',
    );
    expect(onImport).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox'), ' ');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
