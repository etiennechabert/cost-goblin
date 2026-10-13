import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Opts an element out of the frameless window's drag region (the app header).
 *  Chromium resolves `-webkit-app-region` geometrically, ignoring z-order, and
 *  a later drag rect beats an earlier no-drag one — so any surface painted over
 *  the header needs this, or clicks there drag the window instead. The property
 *  is inherited: one class on a portaled root covers its whole subtree. */
export const NO_DRAG = '[-webkit-app-region:no-drag]';
