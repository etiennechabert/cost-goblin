// Merge per-arch electron-updater manifests into one published manifest.
//
// The release builds each arch on its own native-arch runner, so each produces
// its own single-arch `latest-mac.yml` / `latest.yml`. Publishing them as-is
// would let the two jobs clobber each other's manifest (the v0.2.6 auto-update
// regression). Instead the publish job runs this to concatenate their `files`
// lists into one manifest whose sha512/size still match every shipped binary.
//
// Pass the x64 manifest FIRST. It matters for macOS: electron-updater's findFile
// (Provider.js) selects the file whose name contains `process.arch`, else falls
// back to the FIRST file of the right extension — and the mac x64 zip
// (CostGoblin-<ver>-mac.zip) carries no "x64" token, so x64 machines land on
// that shift() fallback, which must be first. (Windows x64/arm64 installers both
// carry an arch token in their names, so order is irrelevant there — but we keep
// x64 first uniformly.) The first input is also the base: its top-level
// version/path/sha512/size/releaseDate are kept.
//
// --minimum-system-version sets the manifest's minimumSystemVersion, which
// electron-updater (checkIfUpdateSupported) compares with semver.lt against
// os.release(): installs on an older OS skip the update and keep the build they
// can run. os.release() is the kernel version, so on macOS it is Darwin's
// (macOS 13 = Darwin 22), not the marketing version.
//
// Usage: node merge-update-manifests.mjs [--minimum-system-version <x.y.z>] <out.yml> <x64.yml> <arm64.yml> [...]

import { readFileSync, writeFileSync } from 'node:fs';
import * as yaml from 'js-yaml';

const args = process.argv.slice(2);
let minimumSystemVersion;
if (args[0] === '--minimum-system-version') {
  minimumSystemVersion = args[1] ?? '';
  args.splice(0, 2);
  // Anything semver.lt can't parse makes electron-updater warn and offer the
  // update anyway, which is the case this flag exists to prevent. That includes
  // a leading zero in any component (022.0.0): strict semver rejects it.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(minimumSystemVersion)) {
    throw new Error(`--minimum-system-version must be x.y.z (a kernel version), got "${minimumSystemVersion}"`);
  }
}

const [out, ...inputs] = args;
if (!out || inputs.length < 2) {
  throw new Error(
    'usage: merge-update-manifests.mjs [--minimum-system-version <x.y.z>] <out.yml> <input1.yml> <input2.yml> [...]',
  );
}

const docs = inputs.map((p) => yaml.load(readFileSync(p, 'utf8')));

// Every input must contribute files — a single-arch (or empty) manifest slipping
// through would publish a latest*.yml missing an arch and break that arch's
// auto-update (the v0.2.6 failure mode). Fail the publish job loudly instead.
docs.forEach((doc, i) => {
  if (!doc || !Array.isArray(doc.files) || doc.files.length === 0) {
    throw new Error(`input ${inputs[i]} has no "files" entries`);
  }
});

const seen = new Set();
const files = [];
for (const doc of docs) {
  for (const f of doc.files) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    files.push(f);
  }
}

// Guard the x64-first invariant the mac shift() fallback depends on: the first
// merged entry must be an x64 artifact (no arm64 token). A reordered call site
// would otherwise silently make x64 Macs resolve the arm64 zip.
if (/arm64/i.test(files[0].url)) {
  throw new Error(`x64 manifest must be passed first, but files[0] is arm64: ${files[0].url}`);
}

const merged = { ...docs[0], files, ...(minimumSystemVersion === undefined ? {} : { minimumSystemVersion }) };
writeFileSync(out, yaml.dump(merged, { lineWidth: -1, forceQuotes: false }));
console.log(`merged ${inputs.length} manifests -> ${out} (${files.length} files)`);
