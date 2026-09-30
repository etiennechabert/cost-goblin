import { describe, it, expect } from 'vitest';
import { buildDuckDbSandboxStatements, isDuckDbSandboxOptions } from '../query/duckdb-sandbox.js';
import type { DuckDbSandboxOptions } from '../query/duckdb-sandbox.js';

const BASE: DuckDbSandboxOptions = {
  allowedDirectories: ['/ws/data', '/ws/tmp/mcp'],
  allowedPaths: ['/ws/state/org-account-tags.json'],
  tempDirectory: '/ws/tmp/mcp',
  maxTempDirectorySizeGB: 10,
  memoryLimitGB: 2,
  threads: 4,
};

describe('buildDuckDbSandboxStatements', () => {
  it('emits the SETs in order, with the lock last', () => {
    expect(buildDuckDbSandboxStatements(BASE)).toEqual([
      "SET memory_limit = '2GB'",
      'SET threads = 4',
      "SET temp_directory = '/ws/tmp/mcp'",
      "SET max_temp_directory_size = '10GB'",
      "SET allowed_directories = ['/ws/data', '/ws/tmp/mcp']",
      "SET allowed_paths = ['/ws/state/org-account-tags.json']",
      'SET enable_external_access = false',
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      'SET lock_configuration = true',
    ]);
  });

  it('restricts access only after the resource limits and before the lock', () => {
    const stmts = buildDuckDbSandboxStatements(BASE);
    const idx = (needle: string): number => stmts.findIndex(s => s.includes(needle));
    expect(idx('temp_directory')).toBeLessThan(idx('allowed_directories'));
    expect(idx('max_temp_directory_size')).toBeLessThan(idx('lock_configuration'));
    expect(idx('allowed_directories')).toBeLessThan(idx('allowed_paths'));
    expect(idx('allowed_paths')).toBeLessThan(idx('enable_external_access'));
    expect(idx('enable_external_access')).toBeLessThan(idx('autoinstall_known_extensions'));
    expect(stmts.at(-1)).toBe('SET lock_configuration = true');
  });

  it("doubles a single quote in every interpolated path", () => {
    const stmts = buildDuckDbSandboxStatements({
      ...BASE,
      allowedDirectories: ["/ws/o'brien/data"],
      allowedPaths: ["/ws/o'brien/state/org-account-tags.json"],
      tempDirectory: "/ws/o'brien/tmp",
    });
    expect(stmts).toContain("SET temp_directory = '/ws/o''brien/tmp'");
    expect(stmts).toContain("SET allowed_directories = ['/ws/o''brien/data']");
    expect(stmts).toContain("SET allowed_paths = ['/ws/o''brien/state/org-account-tags.json']");
  });

  it('emits an empty allowed_paths list when no single files are granted', () => {
    expect(buildDuckDbSandboxStatements({ ...BASE, allowedPaths: [] })).toContain('SET allowed_paths = []');
  });

  it('accepts Windows drive and UNC absolute paths', () => {
    const stmts = buildDuckDbSandboxStatements({
      ...BASE,
      allowedDirectories: ['C:/Users/me/data', String.raw`\\server\share\data`],
      tempDirectory: String.raw`C:\Users\me\tmp`,
    });
    expect(stmts).toContain(String.raw`SET allowed_directories = ['C:/Users/me/data', '\\server\share\data']`);
  });

  it('throws on an empty allowedDirectories list', () => {
    expect(() => buildDuckDbSandboxStatements({ ...BASE, allowedDirectories: [] })).toThrow(/allowedDirectories/);
  });

  it.each([
    ['a relative allowed directory', { allowedDirectories: ['data'] }],
    ['a dot-relative allowed directory', { allowedDirectories: ['./data'] }],
    ['a relative allowed path', { allowedPaths: ['state/org-account-tags.json'] }],
    ['a relative temp directory', { tempDirectory: 'tmp' }],
    ['an empty path', { allowedPaths: [''] }],
    ['a NUL byte in a path', { allowedDirectories: ['/ws/data\u0000/x'] }],
  ])('throws on %s', (_label, override) => {
    expect(() => buildDuckDbSandboxStatements({ ...BASE, ...override })).toThrow(/absolute/);
  });

  it.each([
    ['zero memory', { memoryLimitGB: 0 }],
    ['negative memory', { memoryLimitGB: -1 }],
    ['fractional memory', { memoryLimitGB: 1.5 }],
    ['NaN memory', { memoryLimitGB: Number.NaN }],
    ['infinite memory', { memoryLimitGB: Number.POSITIVE_INFINITY }],
    ['zero threads', { threads: 0 }],
    ['fractional threads', { threads: 2.5 }],
    ['NaN threads', { threads: Number.NaN }],
    ['zero spill cap', { maxTempDirectorySizeGB: 0 }],
    ['fractional spill cap', { maxTempDirectorySizeGB: 0.5 }],
  ])('throws on %s', (_label, override) => {
    expect(() => buildDuckDbSandboxStatements({ ...BASE, ...override })).toThrow(/positive integer/);
  });
});

describe('isDuckDbSandboxOptions', () => {
  it('accepts a well-formed options object', () => {
    expect(isDuckDbSandboxOptions(BASE)).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'sandbox'],
    ['an array', []],
    ['missing allowedDirectories', { ...BASE, allowedDirectories: undefined }],
    ['non-array allowedDirectories', { ...BASE, allowedDirectories: '/ws/data' }],
    ['non-string directory entry', { ...BASE, allowedDirectories: [42] }],
    ['non-array allowedPaths', { ...BASE, allowedPaths: null }],
    ['non-string tempDirectory', { ...BASE, tempDirectory: 1 }],
    ['non-number memoryLimitGB', { ...BASE, memoryLimitGB: '2' }],
    ['non-number threads', { ...BASE, threads: '4' }],
    ['missing maxTempDirectorySizeGB', { ...BASE, maxTempDirectorySizeGB: undefined }],
  ])('rejects %s', (_label, value) => {
    expect(isDuckDbSandboxOptions(value)).toBe(false);
  });
});
