// electron-builder afterPack hook: give the macOS app's main executable a
// Mach-O UUID of its own (see mach-o-uuid.mjs for why). It runs after the app
// is assembled and before electron-builder flips fuses and signs, so the
// rewritten executable is what gets signed and notarized.

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { rewriteMachOUuids } from './mach-o-uuid.mjs';

/** The rewrite breaks the signature Electron's binary ships with, and Apple
 *  Silicon kills an executable whose pages no longer match it. An ad-hoc
 *  signature keeps builds electron-builder doesn't sign (no certificate,
 *  `identity: null`) launchable; a real signing pass replaces it. */
async function adHocSign(file) {
  await promisify(execFile)('codesign', ['--force', '--sign', '-', file]);
}

export function createAfterPack({ sign = adHocSign, hostPlatform = process.platform } = {}) {
  return async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return;
    const { productFilename, id } = context.packager.appInfo;
    const executable = join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
    const buf = await readFile(executable);
    const changes = rewriteMachOUuids(buf, id);
    await writeFile(executable, buf);
    for (const { from, to } of changes) console.log(`  • unique Mach-O UUID  ${from} -> ${to}`);
    if (hostPlatform === 'darwin') {
      await sign(executable);
    } else {
      console.warn('  • no codesign off macOS: the executable needs signing before it can launch on Apple Silicon');
    }
  };
}

export default createAfterPack();
