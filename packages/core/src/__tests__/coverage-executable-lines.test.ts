import { describe, it, expect } from 'vitest';
import { createCoverageReport, restrictToExecutableLines } from '../e2e-coverage/collect.js';
import { executableLines } from '../e2e-coverage/executable-lines.js';
import { generateLcov } from '../e2e-coverage/lcov.js';
import type { FileCoverage } from '../e2e-coverage/types.js';

// Modelled on setup-wizard.tsx's ManualEntry, the component whose PR exposed
// the bug: a multi-line typed signature, statements, and a JSX tree spanning
// many lines under a single `return`.
const COMPONENT = `import { useState } from 'react';

interface Props {
  readonly label: string;
  readonly onSave: (value: string) => void;
}

export function Entry({
  label,
  onSave,
}: Props) {
  const [value, setValue] = useState('');
  if (value === '') {
    return null;
  }
  return (
    <form
      onSubmit={() => {
        onSave(value);
      }}
    >
      <label>{label}</label>
    </form>
  );
}
`;

describe('executableLines', () => {
  it('lists statement start lines only — no signature, type or JSX continuation lines', async () => {
    const lines = await executableLines(COMPONENT, '/repo/packages/ui/src/entry.tsx');
    // 12: const, 13: if, 14: return null, 16: return (, 19: onSave(value).
    // Everything else — the interface, the destructured parameters, the JSX
    // attributes and closing tags — is what the unit report never lists.
    expect([...(lines ?? [])].sort((a, b) => a - b)).toEqual([12, 13, 14, 16, 19]);
  });

  it('finds nothing executable in a type-only module', async () => {
    const source = 'export type A = { a: string };\nexport interface B {\n  b: number;\n}\n';
    const lines = await executableLines(source, '/repo/packages/core/src/types/b.ts');
    expect(lines?.size).toBe(0);
  });

  it('handles plain JavaScript modules', async () => {
    const source = 'export function f(x) {\n  const y = x + 1;\n  return y;\n}\n';
    const lines = await executableLines(source, '/repo/scripts/f.mjs');
    expect([...(lines ?? [])].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('returns null for a file type it does not transform', async () => {
    expect(await executableLines('.a { color: red; }', '/repo/packages/ui/src/a.css')).toBeNull();
  });

  it('throws on source that does not parse rather than reporting no lines', async () => {
    await expect(
      executableLines('export const = ;', '/repo/packages/ui/src/broken.ts'),
    ).rejects.toThrow();
  });
});

function fileCoverage(lines: [number, number][]): FileCoverage {
  return {
    lines: new Map(lines),
    functions: new Map([['Entry:8', { name: 'Entry', line: 8, count: 0 }]]),
    branches: [{ line: 13, blockId: 0, branchId: 0, count: 0 }],
  };
}

describe('restrictToExecutableLines', () => {
  it('drops the lines outside the executable set and keeps every count it retains', () => {
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[11, 0], [12, 3], [13, 0], [17, 1], [19, 0]]));

    const restricted = restrictToExecutableLines(report, new Map([['/repo/a.tsx', new Set([12, 13, 19])]]));

    expect([...(restricted.get('/repo/a.tsx')?.lines ?? [])]).toEqual([[12, 3], [13, 0], [19, 0]]);
  });

  it('leaves functions and branches alone', () => {
    const report = createCoverageReport();
    const original = fileCoverage([[8, 0], [12, 0]]);
    report.set('/repo/a.tsx', original);

    const restricted = restrictToExecutableLines(report, new Map([['/repo/a.tsx', new Set([12])]]));

    expect(restricted.get('/repo/a.tsx')?.functions).toEqual(original.functions);
    expect(restricted.get('/repo/a.tsx')?.branches).toEqual(original.branches);
  });

  it('never adds an executable line the coverage did not report', () => {
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[12, 1]]));

    const restricted = restrictToExecutableLines(report, new Map([['/repo/a.tsx', new Set([12, 13, 14])]]));

    expect([...(restricted.get('/repo/a.tsx')?.lines.keys() ?? [])]).toEqual([12]);
  });

  it('passes through a file it has no executable set for', () => {
    const report = createCoverageReport();
    const untouched = fileCoverage([[1, 0], [2, 1]]);
    report.set('/repo/b.tsx', untouched);

    const restricted = restrictToExecutableLines(report, new Map());

    expect(restricted.get('/repo/b.tsx')).toBe(untouched);
  });

  it('does not mutate the report it was given', () => {
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[11, 0], [12, 1]]));

    restrictToExecutableLines(report, new Map([['/repo/a.tsx', new Set([12])]]));

    expect([...(report.get('/repo/a.tsx')?.lines.keys() ?? [])]).toEqual([11, 12]);
  });

  it('turns an every-line e2e record into the statement-only shape the unit report uses', async () => {
    // What v8-to-istanbul emits for a component no e2e suite renders: every
    // line of the file, all at 0.
    const everyLine = COMPONENT.split('\n').map((_, index): [number, number] => [index + 1, 0]);
    const report = createCoverageReport();
    report.set('/repo/packages/ui/src/entry.tsx', { lines: new Map(everyLine), functions: new Map(), branches: [] });

    const lines = await executableLines(COMPONENT, '/repo/packages/ui/src/entry.tsx');
    if (lines === null) throw new Error('expected a TSX file to be transformable');
    const lcov = generateLcov(restrictToExecutableLines(report, new Map([['/repo/packages/ui/src/entry.tsx', lines]])));

    expect(lcov.split('\n').filter(line => line.startsWith('DA:'))).toEqual([
      'DA:12,0',
      'DA:13,0',
      'DA:14,0',
      'DA:16,0',
      'DA:19,0',
    ]);
    expect(lcov).toContain('LF:5\n');
  });
});
