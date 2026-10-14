// electron-builder afterPack hook: give the macOS app's main executable a
// Mach-O UUID of its own (see mach-o-uuid.mjs for why). It runs after the app
// is assembled and before electron-builder flips fuses and signs, so the
// rewritten executable is what gets signed and notarized.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { rewriteMachOUuids } from './mach-o-uuid.mjs';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return;
  const { productFilename, id } = context.packager.appInfo;
  const executable = join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  const buf = await readFile(executable);
  const changes = rewriteMachOUuids(buf, id);
  await writeFile(executable, buf);
  for (const { from, to } of changes) console.log(`  • unique Mach-O UUID  ${from} -> ${to}`);
}
