import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.js';

afterEach(cleanup);

describe('Dialog', () => {
  it('opts the overlay and content out of window drag regions', () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Test dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    // The overlay covers the frameless window's drag region (app header), so
    // both layers must carve themselves out — otherwise clicks in the top
    // band drag the window instead of reaching the dialog.
    const content = screen.getByRole('dialog');
    expect(content.className).toContain('[-webkit-app-region:no-drag]');
    const overlay = content.previousElementSibling;
    expect(overlay?.className).toContain('[-webkit-app-region:no-drag]');
  });
});
