import { NO_DRAG } from '../lib/utils.js';

const DRAG = '[-webkit-app-region:drag]';

/** The `-webkit-app-region` an element resolves to in the Electron window.
 *  The property is inherited, so the nearest element (self or ancestor) that
 *  sets it decides; a portaled root that sets nothing inherits `none` from
 *  `<body>` and so leaves the header's drag rect live under it. Read from the
 *  Tailwind classes — jsdom has no app-region in computed styles. */
export function appRegionOf(el: Element): 'drag' | 'no-drag' | 'none' {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    if (node.classList.contains(NO_DRAG)) return 'no-drag';
    if (node.classList.contains(DRAG)) return 'drag';
  }
  return 'none';
}
