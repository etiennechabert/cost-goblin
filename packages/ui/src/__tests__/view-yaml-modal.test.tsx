import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewYamlModal } from '../components/view-yaml-modal.js';

afterEach(cleanup);

describe('ViewYamlModal', () => {
  it('opts the modal out of window drag regions', () => {
    render(
      <ViewYamlModal mode="import" existingIds={new Set()} onImport={vi.fn()} onClose={vi.fn()} />,
    );
    // The overlay covers the frameless window's drag region (app header), so
    // it must carve itself out — otherwise backdrop clicks in the top band
    // drag the window instead of dismissing the modal.
    expect(screen.getByRole('dialog').className).toContain('[-webkit-app-region:no-drag]');
  });
});
