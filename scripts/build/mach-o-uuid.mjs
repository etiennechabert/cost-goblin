// Read and rewrite the LC_UUID load commands of a Mach-O executable.
//
// macOS identifies a program for Local Network privacy by its main
// executable's Mach-O UUID (Apple TN3179). The packaged app's executable is the
// stock Electron binary, renamed, so it carries the same UUID as every other
// app on that Electron release, including the Electron.app `npm run dev`
// launches. The privacy rules of all of them then apply to the one UUID, and a
// deny recorded for any of them blocks CostGoblin's connections to the local
// network (peer-sharing pulls fail with EHOSTUNREACH). Rewriting the UUID gives
// the packaged app an identity of its own.
//
// Handles thin 32/64-bit little-endian images and fat (universal) binaries,
// with one LC_UUID per architecture slice. Anything else throws: a build must
// not ship an executable this could not make unique.

import { createHash } from 'node:crypto';

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_UUID = 0x1b;
const LC_CODE_SIGNATURE = 0x1d;
const UUID_COMMAND_SIZE = 24;

export class MachOError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MachOError';
  }
}

function formatUuid(bytes) {
  const hex = bytes.toString('hex').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireRange(buf, start, length, what) {
  if (start < 0 || length < 0 || start + length > buf.length) {
    throw new MachOError(`${what} runs past the end of the file`);
  }
}

/** Absolute offset of the one LC_UUID payload in the image at `base`, and
 *  whether the image carries a code signature. */
function findImageUuid(buf, base, end) {
  requireRange(buf, base, 4, 'Mach-O header');
  const magic = buf.readUInt32LE(base);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
    throw new MachOError(`not a little-endian Mach-O image (magic 0x${magic.toString(16)})`);
  }
  const headerSize = magic === MH_MAGIC_64 ? 32 : 28;
  if (base + headerSize > end) throw new MachOError('Mach-O header runs past the end of the image');
  const ncmds = buf.readUInt32LE(base + 16);
  const sizeofcmds = buf.readUInt32LE(base + 20);
  const cmdsStart = base + headerSize;
  const cmdsEnd = cmdsStart + sizeofcmds;
  if (cmdsEnd > end) throw new MachOError('load commands run past the end of the image');

  let found = null;
  let signed = false;
  let at = cmdsStart;
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > cmdsEnd) throw new MachOError('load commands run past sizeofcmds');
    const cmd = buf.readUInt32LE(at);
    const cmdsize = buf.readUInt32LE(at + 4);
    if (cmdsize < 8 || at + cmdsize > cmdsEnd) throw new MachOError(`load command ${i} has an invalid size (${cmdsize})`);
    if (cmd === LC_UUID) {
      if (cmdsize !== UUID_COMMAND_SIZE) throw new MachOError(`LC_UUID has size ${cmdsize}, expected ${UUID_COMMAND_SIZE}`);
      if (found !== null) throw new MachOError('image has more than one LC_UUID');
      found = at + 8;
    }
    if (cmd === LC_CODE_SIGNATURE) signed = true;
    at += cmdsize;
  }
  if (found === null) throw new MachOError('image has no LC_UUID');
  return { offset: found, signed };
}

/** Every LC_UUID in `buf`: one for a thin image, one per slice of a fat one.
 *  `offset` is where the 16 UUID bytes sit in `buf`; `signed` says the slice
 *  has a code signature, which rewriting the UUID invalidates. Electron ships
 *  its arm64 binaries ad-hoc signed and its x64 ones unsigned. */
export function readMachOUuids(buf) {
  requireRange(buf, 0, 4, 'Mach-O header');
  const fatMagic = buf.readUInt32BE(0);
  const images = [];
  if (fatMagic === FAT_MAGIC || fatMagic === FAT_MAGIC_64) {
    const is64 = fatMagic === FAT_MAGIC_64;
    const entrySize = is64 ? 32 : 20;
    requireRange(buf, 0, 8, 'fat header');
    const count = buf.readUInt32BE(4);
    requireRange(buf, 8, count * entrySize, 'fat architecture table');
    for (let i = 0; i < count; i++) {
      const at = 8 + i * entrySize;
      const offset = is64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
      const size = is64 ? Number(buf.readBigUInt64BE(at + 16)) : buf.readUInt32BE(at + 12);
      requireRange(buf, offset, size, `fat slice ${i}`);
      const image = findImageUuid(buf, offset, offset + size);
      // Rewriting a slice twice would hash the already-rewritten UUID.
      if (images.some((seen) => seen.offset === image.offset)) throw new MachOError(`fat slice ${i} is listed more than once`);
      images.push(image);
    }
    if (images.length === 0) throw new MachOError('fat binary has no slices');
  } else {
    images.push(findImageUuid(buf, 0, buf.length));
  }
  return images.map(({ offset, signed }) => ({ offset, uuid: formatUuid(buf.subarray(offset, offset + 16)), signed }));
}

/** A name-based (version 5 style, SHA-256) UUID from the app id and the
 *  slice's original UUID: unique to this app and this Electron build, and the
 *  same on every rebuild of the same inputs. */
function derivedUuid(appId, original) {
  const bytes = createHash('sha256').update(`costgoblin-mach-o-uuid\0${appId}\0`).update(original).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

/** Rewrite every LC_UUID in `buf` in place; returns what changed. Run it on an
 *  unsigned (or about-to-be re-signed) executable: it invalidates any existing
 *  code signature. */
export function rewriteMachOUuids(buf, appId) {
  return readMachOUuids(buf).map(({ offset, uuid, signed }) => {
    derivedUuid(appId, buf.subarray(offset, offset + 16)).copy(buf, offset);
    return { offset, from: uuid, to: formatUuid(buf.subarray(offset, offset + 16)), signed };
  });
}
