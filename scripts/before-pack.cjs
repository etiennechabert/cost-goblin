// electron-builder beforePack hook: make node_modules/@duckdb arch-correct per target arch.
//
// Why: the release matrix builds BOTH x64 and arm64 installers for every OS on a
// single-arch runner. `npm ci` only installs the host-arch, os/cpu-gated
// `@duckdb/node-bindings-<os>-<arch>` package, and electron-builder copies
// node_modules as-is without filtering by target arch. So without this hook the
// secondary-arch installer ships the wrong-arch duckdb.node and crashes on launch
// (the loader resolves the binding by runtime process.arch and require()s a
// package dir that isn't there).
//
// What: electron-builder packs arches sequentially (concurrency.jobs=1, the
// default — do NOT raise it) and re-reads node_modules from disk for each arch.
// This hook runs once per (platform, arch) before the file copy and rewrites
// node_modules/@duckdb so it contains exactly the binding(s) the target arch
// needs. Missing bindings are fetched from the exact tarball pinned in
// package-lock.json (integrity-verified). npmRebuild stays false — these are
// prebuilt binaries, nothing is compiled.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { Arch } = require("builder-util");

const OS_TOKEN = { darwin: "darwin", mas: "darwin", win32: "win32", linux: "linux" };

// Binding packages a given (os, arch) needs. Linux ships both the glibc and the
// musl variant; the loader picks at runtime via detect-libc.
function wantedBindings(osToken, archName) {
  if (osToken === "linux") {
    return [`node-bindings-linux-${archName}`, `node-bindings-linux-${archName}-musl`];
  }
  return [`node-bindings-${osToken}-${archName}`];
}

function log(msg) {
  process.stdout.write(`  • [duckdb-binding] ${msg}\n`);
}

// A binding dir is usable only if it actually holds the native addon — the file
// the loader requires and the whole point of the swap. Gate on it (not a sibling
// like package.json) so a half-populated dir is never treated as good.
function hasBinding(dir) {
  return fs.existsSync(path.join(dir, "duckdb.node"));
}

function readLockEntry(appDir, bindingName) {
  const lock = JSON.parse(fs.readFileSync(path.join(appDir, "package-lock.json"), "utf8"));
  const entry = lock.packages?.[`node_modules/@duckdb/${bindingName}`];
  if (!entry?.resolved || !entry.integrity) {
    throw new Error(`package-lock.json has no resolved/integrity for @duckdb/${bindingName}`);
  }
  return entry;
}

async function downloadAndExtract(appDir, bindingName, destDir) {
  const { resolved, integrity } = readLockEntry(appDir, bindingName);
  log(`fetching @duckdb/${bindingName} from ${resolved}`);
  const res = await fetch(resolved);
  if (!res.ok) {
    throw new Error(`failed to download @duckdb/${bindingName}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const [algo, expected] = integrity.split("-");
  const actual = crypto.createHash(algo).update(buf).digest("base64");
  if (actual !== expected) {
    throw new Error(`integrity mismatch for @duckdb/${bindingName}: expected ${algo}-${expected}, got ${algo}-${actual}`);
  }

  const tgz = path.join(os.tmpdir(), `duckdb-${bindingName}-${process.pid}.tgz`);
  fs.writeFileSync(tgz, buf);
  fs.mkdirSync(destDir, { recursive: true });
  // `tar` is a real executable on every CI runner (incl. Windows bsdtar) — safe
  // for execFileSync (unlike the npm.cmd shim). --strip-components drops package/.
  execFileSync("tar", ["-xzf", tgz, "-C", destDir, "--strip-components=1"], { stdio: "inherit" });
  fs.rmSync(tgz, { force: true });
}

// Cache (per build process) of extracted binding dirs, so a binding removed for
// one arch and needed for its own arch is restored without re-downloading.
async function ensureInCache(appDir, cacheRoot, duckdbDir, bindingName) {
  const cacheDir = path.join(cacheRoot, bindingName);
  if (hasBinding(cacheDir)) {
    return cacheDir;
  }
  const installed = path.join(duckdbDir, bindingName);
  if (hasBinding(installed)) {
    fs.cpSync(installed, cacheDir, { recursive: true });
    return cacheDir;
  }
  await downloadAndExtract(appDir, bindingName, cacheDir);
  return cacheDir;
}

exports.default = async function beforePack(context) {
  const osToken = OS_TOKEN[context.electronPlatformName];
  if (!osToken) return;
  const archName = Arch[context.arch];
  if (archName !== "x64" && archName !== "arm64") return;

  const appDir = context.packager.info.appDir;
  const duckdbDir = path.join(appDir, "node_modules", "@duckdb");
  if (!fs.existsSync(duckdbDir)) return;

  const wanted = new Set(wantedBindings(osToken, archName));
  const cacheRoot = path.join(os.tmpdir(), `costgoblin-duckdb-bindings-${process.pid}`);

  log(`packing ${context.electronPlatformName}/${archName}: ensuring bindings ${[...wanted].join(", ")}`);

  // Remove bindings not wanted for this arch (preserving them in cache first, so
  // the host-arch binding the runner installed can be restored for its own arch).
  for (const entry of fs.readdirSync(duckdbDir)) {
    if (entry.startsWith("node-bindings-") && !wanted.has(entry)) {
      await ensureInCache(appDir, cacheRoot, duckdbDir, entry);
      fs.rmSync(path.join(duckdbDir, entry), { recursive: true, force: true });
    }
  }

  // Materialize each wanted binding (from cache, or download if absent).
  for (const name of wanted) {
    const dest = path.join(duckdbDir, name);
    if (hasBinding(dest)) continue;
    const src = await ensureInCache(appDir, cacheRoot, duckdbDir, name);
    fs.cpSync(src, dest, { recursive: true });
  }
};
