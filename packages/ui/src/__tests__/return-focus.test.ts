import { afterEach, describe, expect, it } from 'vitest';
import { returnFocusToOpener } from '../lib/return-focus.js';

function button(parent: HTMLElement = document.body): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  parent.append(el);
  return el;
}

describe('returnFocusToOpener', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('focuses an opener that is still on the page', () => {
    const opener = button();
    expect(returnFocusToOpener(opener)).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone for no opener, <body>, or one that is gone', () => {
    const gone = button();
    gone.remove();
    expect(returnFocusToOpener(null)).toBe(false);
    expect(returnFocusToOpener(document.body)).toBe(false);
    expect(returnFocusToOpener(gone)).toBe(false);
  });

  it('leaves focus alone when the opener is hidden behind another open modal', () => {
    const page = document.createElement('div');
    page.setAttribute('aria-hidden', 'true');
    document.body.append(page);
    const opener = button(page);
    expect(returnFocusToOpener(opener)).toBe(false);
    expect(document.activeElement).not.toBe(opener);
  });
});
