import { waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/** The backdrop of a modal dialog — what a click outside the dialog lands on.
 *  The dialog sits inside its own backdrop (the backdrop is the scroll
 *  container), so the nearest one up from the dialog is its own even while
 *  other modals are stacked around it. */
export function backdropOf(dialog: Element): HTMLElement {
  const backdrop = dialog.parentElement?.closest('[data-testid="modal-backdrop"]');
  if (!(backdrop instanceof HTMLElement)) throw new Error('backdrop not found');
  return backdrop;
}

/** Waits until `layer` is the layer in charge — the one that takes pointer
 *  input, focus and Escape — and each of `below` has stopped taking pointer
 *  input.
 *
 *  Radix re-ranks its layers in a render that follows the one opening or
 *  closing a layer. A layer opened outside a user event (a rerender here, an
 *  update push in the app) is painted and focused before that render lands,
 *  and until it does the layer under it still owns Escape — a moment in the
 *  app, but long enough in a test for the next simulated key to land first. */
export async function expectTopLayer(layer: Element, below: readonly Element[] = []): Promise<void> {
  await waitFor(() => {
    expect(getComputedStyle(layer).pointerEvents).toBe('auto');
    for (const el of below) expect(getComputedStyle(el).pointerEvents).toBe('none');
  });
}
