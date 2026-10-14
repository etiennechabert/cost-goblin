// electron-builder afterPack hook: give the macOS app's main executable a
// Mach-O UUID of its own (see mach-o-uuid.mjs for why). It runs after the app
// is assembled and before electron-builder flips fuses and signs, so the
// rewritten executable is what gets signed and notarized.

import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { rewriteMachOUuids } from './mach-o-uuid.mjs';

/** The rewrite breaks the signature Electron's arm64 binary ships with, and
 *  Apple Silicon kills an executable whose pages no longer match it. An ad-hoc
 *  signature keeps builds electron-builder doesn't sign (no certificate,
 *  `identity: null`) launchable; a real signing pass replaces it.
 *
 *  Signs a copy outside the bundle: given a bundle's main executable, codesign
 *  signs the whole bundle and refuses when nested code is unsigned, as
 *  Electron x64's frameworks are (that failed the v0.8.6 x64 release). */
async function adHocSign(file, identifier) {
  const dir = await mkdtemp(join(tmpdir(), 'costgoblin-sign-'));
  try {
    const standalone = join(dir, basename(file));
    await copyFile(file, standalone);
    // Outside the bundle codesign would name it after the file; keep the app id.
    await promisify(execFile)('codesign', ['--force', '--sign', '-', '--identifier', identifier, standalone]);
    await writeFile(file, await readFile(standalone));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createAfterPack({ sign = adHocSign, hostPlatform = process.platform } = {}) {
  return async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return;
    const { productFilename, id } = context.packager.appInfo;
    const executable = join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
    const buf = await readFile(executable);
    const changes = rewriteMachOUuids(buf, id);
    // Electron's x64 executable ships unsigned: nothing to repair there.
    const signatureBroken = changes.some((change) => change.signed);
    if (signatureBroken && hostPlatform !== 'darwin') {
      // codesign is macOS-only; a shared UUID beats an executable Apple
      // Silicon refuses to launch.
      console.warn('  • kept the stock Mach-O UUID: the executable could not be re-signed off macOS');
      return;
    }
    await writeFile(executable, buf);
    for (const { from, to } of changes) console.log(`  • unique Mach-O UUID  ${from} -> ${to}`);
    if (signatureBroken) await sign(executable, id);
  };
}

export default createAfterPack();
