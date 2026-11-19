/**
 * `value` as the DOM serializes it once written to `property` of an element's
 * inline style: `calc(100vh - 64px)` reads back as `calc(-64px + 100vh)` and a
 * hex colour as `rgb(…)`. A test compares a style it reads from the page with
 * this, not with the string the component wrote, so it doesn't depend on how
 * one jsdom version serializes CSS (jsdom 31 started doing it as browsers do).
 */
export function normalizeCss(property: string, value: string): string {
  const scratch = document.createElement('div');
  scratch.style.setProperty(property, value);
  return scratch.style.getPropertyValue(property);
}
