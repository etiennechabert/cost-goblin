/**
 * `value` as the DOM serializes it once written to `property` of an element's
 * inline style: `calc(100vh - 64px)` reads back as `calc(-64px + 100vh)` and a
 * hex colour as `rgb(…)`. A test compares a style it reads from the page with
 * this, not with the string the component wrote, so it doesn't depend on how
 * one jsdom version serializes CSS (jsdom 31 started doing it as browsers do).
 * Throws when jsdom drops the value (an unknown property, a camelCase name, a
 * value it can't parse), which would otherwise compare equal to an unset style.
 */
export function normalizeCss(property: string, value: string): string {
  const scratch = document.createElement('div');
  scratch.style.setProperty(property, value);
  const serialized = scratch.style.getPropertyValue(property);
  if (serialized === '') throw new Error(`jsdom did not accept ${property}: ${value}`);
  return serialized;
}
