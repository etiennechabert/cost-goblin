import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Every portaled overlay (Radix dialogs, ModalShell, popovers, the command
 *  palette) shares one z-index, `z-50`, so the one opened last paints on top —
 *  the same layer Radix gives pointer, focus and Escape to. A surface above
 *  that token paints over a dialog opened after it while sitting under that
 *  dialog's pointer lock: the "Switch workspace" confirm whose clicks fell
 *  through to the release notes' links. */

const OVERLAY_Z = 50;
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Tailwind z-index classes (`z-50`, `z-[100]`, with any variant prefix) and
 *  inline `zIndex` values, with the value each sets. */
function zIndexesIn(source: string): { readonly token: string; readonly value: number }[] {
  const classes = [...source.matchAll(/(?<![\w-])z-(?:\[(\d+)\]|(\d+))(?![\w-])/g)].map((m) => ({
    token: m[0],
    value: Number(m[1] ?? m[2]),
  }));
  const inline = [...source.matchAll(/zIndex:\s*(\d+)/g)].map((m) => ({ token: m[0], value: Number(m[1]) }));
  return [...classes, ...inline];
}

describe('z-index policy', () => {
  it('reads the UI sources it polices', () => {
    const files = sourceFiles(SRC).map((file) => relative(SRC, file));
    expect(files).toContain(join('components', 'command-palette.tsx'));
    expect(files).toContain(join('components', 'ui', 'modal-shell.tsx'));
  });

  it(`puts nothing above the overlay token (z-${String(OVERLAY_Z)})`, () => {
    const above = sourceFiles(SRC).flatMap((file) =>
      zIndexesIn(readFileSync(file, 'utf8'))
        .filter(({ value }) => value > OVERLAY_Z)
        .map(({ token }) => `${relative(SRC, file)}: ${token}`),
    );
    expect(above).toEqual([]);
  });

  it('recognises the forms it bans', () => {
    expect(zIndexesIn(`className="fixed z-[100] md:z-60" style={{ zIndex: 70 }}`).map(({ value }) => value)).toEqual([100, 60, 70]);
    // A negative z-index, and words that merely end in "z-N", are not z-index classes.
    expect(zIndexesIn('className="-z-10 lazy-z-90"')).toEqual([]);
  });
});
