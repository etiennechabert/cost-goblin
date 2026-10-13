/** Gives focus back to what had it when a modal opened, when that still makes
 *  sense: not gone, not <body>, and not behind another modal that is still
 *  open. Radix hides the page behind an open modal from assistive tech
 *  (aria-hidden); a dialog replaced by another in the same commit — baseline
 *  triage re-keys its dialog per item — closes with its opener hidden behind
 *  the new one, and focusing it there would scroll the page to it and announce
 *  it before the new dialog's focus trap pulls focus back. Returns whether it
 *  moved focus, so a close handler knows whether to keep Radix's default. */
export function returnFocusToOpener(opener: Element | null): boolean {
  if (!(opener instanceof HTMLElement) || opener === document.body || !opener.isConnected) return false;
  if (opener.closest('[aria-hidden="true"]') !== null) return false;
  opener.focus();
  return true;
}
