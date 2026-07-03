import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../components/command-palette.js';

afterEach(cleanup);

const items = [{ id: 'overview', label: 'Overview' }];

describe('CommandPalette', () => {
  it('opts the overlay and content out of window drag regions', async () => {
    const user = userEvent.setup();
    render(<CommandPalette items={items} onNavigate={vi.fn()} />);
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByPlaceholderText('Type to search...');

    // The overlay covers the frameless window's drag region (app header), so
    // both layers must carve themselves out — otherwise clicks in the top
    // band drag the window instead of dismissing the palette.
    const overlay = document.querySelector('[cmdk-overlay]');
    expect(overlay?.className).toContain('[-webkit-app-region:no-drag]');
    const content = document.querySelector('[cmdk-dialog]');
    expect(content?.className).toContain('[-webkit-app-region:no-drag]');
  });
});
