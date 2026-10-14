// The packaged macOS app's main executable is the stock Electron binary, and
// macOS keys Local Network privacy on that executable's Mach-O UUID. Every app
// on the same Electron release shares it, so a deny recorded for any of them
// (the `npm run dev` Electron.app, Slack, ...) blocks CostGoblin's LAN
// connections too: peer-sharing pulls then fail with EHOSTUNREACH. The
// afterPack hook gives the packaged executable a UUID of its own; these tests
// pin the Mach-O rewrite on synthetic binaries, the real Electron binary when
// it is installed, and the hook's wiring in electron-builder.yml.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import afterPack, { createAfterPack } from './after-pack.mjs';
import { MachOError, readMachOUuids, rewriteMachOUuids } from './mach-o-uuid.mjs';

const LC_UUID = 0x1b;
const LC_SEGMENT_64 = 0x19;
const LC_MAIN = 0x80000028;
const LC_CODE_SIGNATURE = 0x1d;
const CPU_ARM64 = 0x0100000c;
const CPU_X86_64 = 0x01000007;

const UUID_A = Buffer.from('4c4c44f855553144a1b8270b7145eda0', 'hex');
const UUID_B = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');

function loadCommand(cmd, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(cmd, 0);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

/** A little-endian Mach-O with a segment, an LC_UUID and an LC_MAIN, then a
 *  payload — enough structure for the walker to have to skip commands. */
function thinMachO({ uuid = UUID_A, cputype = CPU_ARM64, is64 = true, commands } = {}) {
  const cmds = commands ?? [
    loadCommand(LC_SEGMENT_64, Buffer.alloc(64, 0x11)),
    loadCommand(LC_UUID, uuid),
    loadCommand(LC_MAIN, Buffer.alloc(16, 0x22)),
  ];
  const body = Buffer.concat(cmds);
  const header = Buffer.alloc(is64 ? 32 : 28);
  header.writeUInt32LE(is64 ? 0xfeedfacf : 0xfeedface, 0);
  header.writeUInt32LE(cputype, 4);
  header.writeUInt32LE(2, 12); // MH_EXECUTE
  header.writeUInt32LE(cmds.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, Buffer.alloc(64, 0x33)]);
}

/** Like Electron's arm64 binaries, which ship ad-hoc (linker) signed; its x64
 *  ones ship unsigned, like thinMachO(). */
function signedMachO(opts = {}) {
  return thinMachO({
    ...opts,
    commands: [
      loadCommand(LC_SEGMENT_64, Buffer.alloc(64, 0x11)),
      loadCommand(LC_UUID, opts.uuid ?? UUID_A),
      loadCommand(LC_CODE_SIGNATURE, Buffer.alloc(8, 0x44)),
    ],
  });
}

/** A universal binary: big-endian fat header, each slice at a 0x1000 boundary. */
function fatMachO(slices, { is64 = false } = {}) {
  const entrySize = is64 ? 32 : 20;
  const header = Buffer.alloc(8 + slices.length * entrySize);
  header.writeUInt32BE(is64 ? 0xcafebabf : 0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  const parts = [header];
  let offset = 0x1000;
  slices.forEach(({ cputype, data }, i) => {
    const at = 8 + i * entrySize;
    header.writeUInt32BE(cputype, at);
    if (is64) {
      header.writeBigUInt64BE(BigInt(offset), at + 8);
      header.writeBigUInt64BE(BigInt(data.length), at + 16);
      header.writeUInt32BE(12, at + 24);
    } else {
      header.writeUInt32BE(offset, at + 8);
      header.writeUInt32BE(data.length, at + 12);
      header.writeUInt32BE(12, at + 16);
    }
    const used = parts.reduce((n, p) => n + p.length, 0);
    parts.push(Buffer.alloc(offset - used), data);
    offset += 0x1000;
  });
  return Buffer.concat(parts);
}

function differingOffsets(a, b) {
  const out = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe('readMachOUuids', () => {
  it('finds the LC_UUID of a thin 64-bit binary past the other load commands', () => {
    const bin = thinMachO();
    const found = readMachOUuids(bin);
    expect(found).toEqual([{ offset: 32 + 72 + 8, uuid: '4C4C44F8-5555-3144-A1B8-270B7145EDA0', signed: false }]);
  });

  it('says which slices carry a code signature the rewrite will break', () => {
    expect(readMachOUuids(signedMachO()).map((u) => u.signed)).toEqual([true]);
    const fat = fatMachO([
      { cputype: CPU_X86_64, data: thinMachO({ cputype: CPU_X86_64 }) },
      { cputype: CPU_ARM64, data: signedMachO({ uuid: UUID_B }) },
    ]);
    expect(readMachOUuids(fat).map((u) => u.signed)).toEqual([false, true]);
  });

  it('reads 32-bit thin binaries and both fat header widths', () => {
    expect(readMachOUuids(thinMachO({ is64: false }))).toHaveLength(1);
    for (const is64 of [false, true]) {
      const bin = fatMachO([
        { cputype: CPU_X86_64, data: thinMachO({ uuid: UUID_A, cputype: CPU_X86_64 }) },
        { cputype: CPU_ARM64, data: thinMachO({ uuid: UUID_B }) },
      ], { is64 });
      expect(readMachOUuids(bin).map((u) => u.uuid)).toEqual([
        '4C4C44F8-5555-3144-A1B8-270B7145EDA0',
        '01234567-89AB-CDEF-0123-456789ABCDEF',
      ]);
    }
  });

  it('rejects input that is not a well-formed Mach-O instead of guessing', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...Array(60).fill(0)]);
    expect(() => readMachOUuids(elf)).toThrow(MachOError);
    expect(() => readMachOUuids(Buffer.alloc(3))).toThrow(MachOError);
    // No LC_UUID at all: nothing to make unique, and macOS would fall back to
    // other identification — fail the build rather than ship unchanged.
    expect(() => readMachOUuids(thinMachO({ commands: [loadCommand(LC_MAIN, Buffer.alloc(16))] }))).toThrow(/no LC_UUID/);
    // Two LC_UUIDs in one image is malformed.
    expect(() => readMachOUuids(thinMachO({ commands: [loadCommand(LC_UUID, UUID_A), loadCommand(LC_UUID, UUID_B)] }))).toThrow(MachOError);
    // An LC_UUID whose size is not 24.
    expect(() => readMachOUuids(thinMachO({ commands: [loadCommand(LC_UUID, Buffer.alloc(20))] }))).toThrow(MachOError);
  });

  it('rejects load commands and fat slices that run past the buffer', () => {
    const bin = thinMachO();
    bin.writeUInt32LE(4096, 32 + 4); // first cmdsize far beyond the header's sizeofcmds
    expect(() => readMachOUuids(bin)).toThrow(MachOError);
    const tiny = thinMachO();
    tiny.writeUInt32LE(4, 32 + 4); // cmdsize < 8 would loop forever
    expect(() => readMachOUuids(tiny)).toThrow(MachOError);
    const fat = fatMachO([{ cputype: CPU_ARM64, data: thinMachO() }]);
    fat.writeUInt32BE(0x100000, 8 + 12); // slice size past EOF
    expect(() => readMachOUuids(fat)).toThrow(MachOError);
    // A slice too short for its own header must not read the next slice's bytes.
    const short = fatMachO([{ cputype: CPU_ARM64, data: thinMachO() }, { cputype: CPU_X86_64, data: thinMachO({ uuid: UUID_B }) }]);
    short.writeUInt32BE(16, 8 + 12);
    expect(() => readMachOUuids(short)).toThrow(/header/);
  });

  it('rejects a fat table that lists the same slice twice, which would rewrite it twice', () => {
    const fat = fatMachO([
      { cputype: CPU_X86_64, data: thinMachO({ uuid: UUID_A, cputype: CPU_X86_64 }) },
      { cputype: CPU_ARM64, data: thinMachO({ uuid: UUID_B }) },
    ]);
    fat.writeUInt32BE(fat.readUInt32BE(8 + 8), 8 + 20 + 8);
    fat.writeUInt32BE(fat.readUInt32BE(8 + 12), 8 + 20 + 12);
    expect(() => readMachOUuids(fat)).toThrow(/more than once/);
  });
});

describe('rewriteMachOUuids', () => {
  it('changes only the 16 UUID bytes, to an RFC 4122 version-5 UUID', () => {
    const original = thinMachO();
    const bin = Buffer.from(original);
    const [change] = rewriteMachOUuids(bin, 'com.costgoblin.app');
    expect(change.from).toBe('4C4C44F8-5555-3144-A1B8-270B7145EDA0');
    expect(change.to).not.toBe(change.from);
    expect(change.to).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    const offsets = differingOffsets(original, bin);
    expect(offsets.length).toBeGreaterThan(0);
    expect(offsets.every((o) => o >= change.offset && o < change.offset + 16)).toBe(true);
    expect(readMachOUuids(bin)[0].uuid).toBe(change.to);
  });

  it('is deterministic per app and per original UUID, so builds stay reproducible', () => {
    const first = rewriteMachOUuids(thinMachO(), 'com.costgoblin.app')[0].to;
    expect(rewriteMachOUuids(thinMachO(), 'com.costgoblin.app')[0].to).toBe(first);
    expect(rewriteMachOUuids(thinMachO(), 'com.example.other')[0].to).not.toBe(first);
    expect(rewriteMachOUuids(thinMachO({ uuid: UUID_B }), 'com.costgoblin.app')[0].to).not.toBe(first);
  });

  it('gives every slice of a universal binary its own UUID and leaves the fat header alone', () => {
    const original = fatMachO([
      { cputype: CPU_X86_64, data: thinMachO({ uuid: UUID_A, cputype: CPU_X86_64 }) },
      { cputype: CPU_ARM64, data: thinMachO({ uuid: UUID_B }) },
    ]);
    const bin = Buffer.from(original);
    const changes = rewriteMachOUuids(bin, 'com.costgoblin.app');
    expect(changes).toHaveLength(2);
    expect(new Set(changes.map((c) => c.to)).size).toBe(2);
    expect(bin.subarray(0, 48)).toEqual(original.subarray(0, 48));
    expect(differingOffsets(original, bin).every((o) => changes.some((c) => o >= c.offset && o < c.offset + 16))).toBe(true);
  });
});

describe('afterPack hook', () => {
  let dir;
  let signed;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'after-pack-'));
    signed = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const context = (electronPlatformName) => ({
    electronPlatformName,
    appOutDir: dir,
    packager: { appInfo: { productFilename: 'CostGoblin', id: 'com.costgoblin.app' } },
  });
  const executable = () => join(dir, 'CostGoblin.app', 'Contents', 'MacOS', 'CostGoblin');
  const hook = (hostPlatform) => createAfterPack({ hostPlatform, sign: async (file, identifier) => { signed.push({ file, identifier }); } });
  const writeExecutable = (data = signedMachO()) => {
    mkdirSync(join(dir, 'CostGoblin.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(executable(), data);
  };

  it('is what electron-builder loads as the default export', () => {
    expect(typeof afterPack).toBe('function');
  });

  it('rewrites the packaged macOS executable in place, then re-signs it', async () => {
    writeExecutable();
    await hook('darwin')(context('darwin'));
    const [uuid] = readMachOUuids(readFileSync(executable()));
    expect(uuid.uuid).toBe(rewriteMachOUuids(signedMachO(), 'com.costgoblin.app')[0].to);
    // The rewrite breaks Electron's signature; an unsigned build (no
    // certificate) would otherwise be killed at launch on Apple Silicon.
    // Signed as the app, like codesign signing it inside the bundle would.
    expect(signed).toEqual([{ file: executable(), identifier: 'com.costgoblin.app' }]);
  });

  it('leaves an executable that shipped unsigned unsigned, as Electron x64 does', async () => {
    writeExecutable(thinMachO({ cputype: CPU_X86_64 }));
    await hook('darwin')(context('darwin'));
    expect(readMachOUuids(readFileSync(executable()))[0].uuid).not.toBe('4C4C44F8-5555-3144-A1B8-270B7145EDA0');
    expect(signed).toEqual([]);
  });

  it('leaves a signed executable untouched off macOS, where it could not be re-signed', async () => {
    // A shared UUID beats an executable Apple Silicon refuses to launch.
    writeExecutable();
    await hook('linux')(context('darwin'));
    expect(readFileSync(executable())).toEqual(signedMachO());
    expect(signed).toEqual([]);
  });

  it('still rewrites an unsigned executable off macOS: there is no signature to break', async () => {
    writeExecutable(thinMachO({ cputype: CPU_X86_64 }));
    await hook('linux')(context('darwin'));
    expect(readMachOUuids(readFileSync(executable()))[0].uuid).not.toBe('4C4C44F8-5555-3144-A1B8-270B7145EDA0');
    expect(signed).toEqual([]);
  });

  it('leaves Windows and Linux packages alone', async () => {
    await expect(hook('darwin')(context('win32'))).resolves.toBeUndefined();
    await expect(hook('darwin')(context('linux'))).resolves.toBeUndefined();
    expect(signed).toEqual([]);
  });

  it('fails the build when the macOS executable is missing rather than shipping it shared', async () => {
    await expect(hook('darwin')(context('darwin'))).rejects.toThrow(/CostGoblin\.app\/Contents\/MacOS\/CostGoblin/);
  });
});

const electronExe = join(import.meta.dirname, '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

/** Like Electron's own linker signature, the ad-hoc one covers the executable
 *  alone (what the kernel checks at launch), not the bundle's resources, so it
 *  is verified on a copy outside the bundle. */
function expectValidStandaloneSignature(exe, dir) {
  const standalone = join(dir, 'standalone-executable');
  writeFileSync(standalone, readFileSync(exe));
  const verify = spawnSync('codesign', ['--verify', '--strict', standalone], { encoding: 'utf8' });
  expect(verify.stderr).toBe('');
  expect(verify.status).toBe(0);
  const details = spawnSync('codesign', ['-dv', standalone], { encoding: 'utf8' });
  expect(details.stderr).toContain('Identifier=com.costgoblin.app');
}

describe.skipIf(!existsSync(electronExe))('the installed Electron binary', () => {
  it('has the LC_UUIDs dwarfdump reports, and only those bytes change', () => {
    const original = readFileSync(electronExe);
    const found = readMachOUuids(original);
    const dwarfdump = spawnSync('dwarfdump', ['--uuid', electronExe], { encoding: 'utf8' });
    if (dwarfdump.status === 0) {
      const reported = [...dwarfdump.stdout.matchAll(/UUID: ([0-9A-F-]{36})/g)].map((m) => m[1]);
      expect(found.map((u) => u.uuid)).toEqual(reported);
    }
    const bin = Buffer.from(original);
    const changes = rewriteMachOUuids(bin, 'com.costgoblin.app');
    expect(changes).toHaveLength(found.length);
    expect(differingOffsets(original, bin).every((o) => changes.some((c) => o >= c.offset && o < c.offset + 16))).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('comes out of the real hook with a valid signature', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'after-pack-real-'));
    try {
      const exe = join(dir, 'CostGoblin.app', 'Contents', 'MacOS', 'CostGoblin');
      mkdirSync(join(dir, 'CostGoblin.app', 'Contents', 'MacOS'), { recursive: true });
      writeFileSync(exe, readFileSync(electronExe), { mode: 0o755 });
      await afterPack({ electronPlatformName: 'darwin', appOutDir: dir, packager: { appInfo: { productFilename: 'CostGoblin', id: 'com.costgoblin.app' } } });
      expect(readMachOUuids(readFileSync(exe)).map((u) => u.uuid)).not.toEqual(readMachOUuids(readFileSync(electronExe)).map((u) => u.uuid));
      expectValidStandaloneSignature(exe, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The v0.8.6 x64 release job failed here: codesign given an executable inside
  // a bundle signs the bundle, and refuses when nested code (Electron x64's
  // frameworks) is unsigned. The executable must be signed on its own.
  it.skipIf(process.platform !== 'darwin')('re-signs the executable even when the bundle holds unsigned frameworks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'after-pack-nested-'));
    try {
      const app = join(dir, 'CostGoblin.app');
      const exe = join(app, 'Contents', 'MacOS', 'CostGoblin');
      const framework = join(app, 'Contents', 'Frameworks', 'Electron Framework.framework');
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
      mkdirSync(join(framework, 'Versions', 'A'), { recursive: true });
      writeFileSync(exe, readFileSync(electronExe), { mode: 0o755 });
      const frameworkBinary = join(framework, 'Versions', 'A', 'Electron Framework');
      writeFileSync(frameworkBinary, readFileSync(electronExe), { mode: 0o755 });
      expect(spawnSync('codesign', ['--remove-signature', frameworkBinary]).status).toBe(0);
      symlinkSync('A', join(framework, 'Versions', 'Current'));
      symlinkSync('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));

      await afterPack({ electronPlatformName: 'darwin', appOutDir: dir, packager: { appInfo: { productFilename: 'CostGoblin', id: 'com.costgoblin.app' } } });

      expectValidStandaloneSignature(exe, dir);
      expect(readdirSync(join(app, 'Contents', 'MacOS'))).toEqual(['CostGoblin']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('electron-builder.yml', () => {
  const config = yaml.load(readFileSync(join(import.meta.dirname, '../../electron-builder.yml'), 'utf8'));

  it('runs the UUID rewrite after packing (before electron-builder signs)', () => {
    expect(config.afterPack).toBe('./scripts/build/after-pack.mjs');
  });

  it('explains Local Network access in the permission prompt', () => {
    expect(config.mac.extendInfo.NSLocalNetworkUsageDescription).toMatch(/local network/i);
  });
});
