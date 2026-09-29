/** Callback ref that focuses its element once, when it mounts. For the search
 *  box of a dropdown the user has just opened: focus follows their own action
 *  into the popup, which is the expected pattern there (not page-load focus
 *  theft, which is what the `autoFocus` prop is flagged for).
 *
 *  Module-level on purpose: a ref with a stable identity runs on mount only.
 *  An inline arrow is re-invoked on every render and would pull focus back
 *  from anything else the user clicked inside the popup. */
export function focusOnMount(el: HTMLElement | null): void {
  el?.focus();
}
