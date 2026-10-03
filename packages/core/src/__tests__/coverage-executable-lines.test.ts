import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createCoverageReport, restrictToExecutableLines } from '../e2e-coverage/collect.js';
import { executableLines, restrictToStatementLines } from '../e2e-coverage/executable-lines.js';
import { generateLcov } from '../e2e-coverage/lcov.js';
import type { ExecutableLines, FileCoverage } from '../e2e-coverage/types.js';

// Paths inside the real packages, so the transform resolves the same tsconfig
// (and with it the JSX mode and target) it does for the collector. The files
// need not exist: the source is passed in.
const PACKAGES = join(import.meta.dirname, '..', '..', '..');
const UI_FILE = join(PACKAGES, 'ui', 'src', 'entry.tsx');
const CORE_FILE = join(PACKAGES, 'core', 'src', 'check.ts');

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
  it('lists statement and branch start lines only — no signature, type or JSX continuation lines', async () => {
    const lines = await executableLines(COMPONENT, UI_FILE);
    // 12: const, 13: if, 14: return null, 16: return (, 19: onSave(value).
    // Everything else — the interface, the destructured parameters, the JSX
    // attributes and closing tags — is what the unit report never lists.
    expect(lines.statements).toEqual(new Set([12, 13, 14, 16, 19]));
    expect(lines.branches).toEqual(new Set([13]));
  });

  it('puts a branch on its node start line, where the unit lcov writes BRDA', async () => {
    const source = "export const label = (n: number): string =>\n  n > 1 ? 'many' : 'one';\n";
    const lines = await executableLines(source, CORE_FILE);
    expect(lines.statements).toEqual(new Set([1, 2]));
    expect(lines.branches).toEqual(new Set([2]));
  });

  it('follows vite’s module-runner transform for calls to imported bindings, as vitest does', async () => {
    // The runner rewrites the body to `(0,__vite_ssr_import_0__.isThing)(…)`;
    // its unmapped `(0,` takes the previous token's line, so vitest's unit
    // report lists the body on line 5, not line 7.
    const source = [
      "import { isThing } from './thing.js';",
      '',
      'export const check = (',
      '  key: string,',
      '  other: string,',
      '): boolean =>',
      '  isThing(key, other);',
      '',
    ].join('\n');
    const lines = await executableLines(source, CORE_FILE);
    expect(lines.statements).toEqual(new Set([3, 5]));
  });

  it('honours v8 ignore start/stop regions', async () => {
    const source = [
      'export function f(x: number): number {',
      '  /* v8 ignore start */',
      '  if (x < 0) {',
      "    throw new Error('negative');",
      '  }',
      '  /* v8 ignore stop */',
      '  return x * 2;',
      '}',
      '',
    ].join('\n');
    const lines = await executableLines(source, CORE_FILE);
    expect(lines.statements).toEqual(new Set([7]));
    expect(lines.branches).toEqual(new Set());
  });

  it('finds nothing executable in a type-only module', async () => {
    const source = 'export type A = { a: string };\nexport interface B {\n  b: number;\n}\n';
    const lines = await executableLines(source, CORE_FILE);
    expect(lines).toEqual({ statements: new Set(), branches: new Set() });
  });

  it('throws on source that does not parse rather than reporting no lines', async () => {
    await expect(executableLines('export const = ;', CORE_FILE)).rejects.toThrow();
  });
});

function fileCoverage(
  lines: [number, number][],
  branchLines: number[] = [],
): FileCoverage {
  return {
    lines: new Map(lines),
    functions: new Map([['Entry:8', { name: 'Entry', line: 8, count: 0 }]]),
    branches: branchLines.map((line, blockId) => ({ line, blockId, branchId: 0, count: 0 })),
  };
}

function executable(statements: number[], branches: number[] = []): ExecutableLines {
  return { statements: new Set(statements), branches: new Set(branches) };
}

describe('restrictToExecutableLines', () => {
  it('keeps statement lines whatever their count and drops every other line', () => {
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[11, 0], [12, 3], [13, 0], [17, 1], [19, 0]]));

    const restricted = restrictToExecutableLines(
      report,
      new Map([['/repo/a.tsx', executable([12, 13, 19])]]),
    );

    expect(restricted.get('/repo/a.tsx')?.lines).toEqual(new Map([[12, 3], [13, 0], [19, 0]]));
  });

  it('keeps a branch-only line the unit report lists only when e2e executed it', () => {
    // SonarJS credits a line with BRDA records its covered branches only when
    // no DA came first; an e2e zero there would block that credit.
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[30, 2], [31, 0]]));

    const restricted = restrictToExecutableLines(
      report,
      new Map([['/repo/a.tsx', executable([], [30, 31])]]),
    );

    expect(restricted.get('/repo/a.tsx')?.lines).toEqual(new Map([[30, 2]]));
  });

  it('keeps a line carrying one of its own branch records only when e2e executed it', () => {
    // `} else {` under an untaken else: dropping its positive DA would leave
    // only the zero BRDA, and Sonar would flip the executed line to uncovered.
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[40, 5], [41, 0]], [40, 41]));

    const restricted = restrictToExecutableLines(report, new Map([['/repo/a.tsx', executable([])]]));

    expect(restricted.get('/repo/a.tsx')?.lines).toEqual(new Map([[40, 5]]));
  });

  it('leaves functions and branches alone', () => {
    const report = createCoverageReport();
    const original = fileCoverage([[8, 0], [12, 0]], [12]);
    report.set('/repo/a.tsx', original);

    const restricted = restrictToExecutableLines(report, new Map([['/repo/a.tsx', executable([12])]]));

    expect(restricted.get('/repo/a.tsx')?.functions).toEqual(original.functions);
    expect(restricted.get('/repo/a.tsx')?.branches).toEqual(original.branches);
  });

  it('never adds an executable line the coverage did not report', () => {
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[12, 1]]));

    const restricted = restrictToExecutableLines(
      report,
      new Map([['/repo/a.tsx', executable([12, 13], [14])]]),
    );

    expect(restricted.get('/repo/a.tsx')?.lines).toEqual(new Map([[12, 1]]));
  });

  it('passes through a file it has no executable lines for', () => {
    const report = createCoverageReport();
    const untouched = fileCoverage([[1, 0], [2, 1]]);
    report.set('/repo/b.tsx', untouched);

    expect(restrictToExecutableLines(report, new Map()).get('/repo/b.tsx')).toBe(untouched);
  });

  it('does not mutate the report it was given', () => {
    const report = createCoverageReport();
    report.set('/repo/a.tsx', fileCoverage([[11, 0], [12, 1]]));

    restrictToExecutableLines(report, new Map([['/repo/a.tsx', executable([12])]]));

    expect(report.get('/repo/a.tsx')?.lines).toEqual(new Map([[11, 0], [12, 1]]));
  });
});

describe('restrictToStatementLines', () => {
  it('turns an every-line e2e record into the statement-only shape the unit report uses', async () => {
    // What v8-to-istanbul emits for a component no e2e suite renders: every
    // line of the file, all at 0, and no branches (V8 reports none for a
    // function that never ran).
    const everyLine = COMPONENT.split('\n').map((_, index): [number, number] => [index + 1, 0]);
    const report = createCoverageReport();
    report.set(UI_FILE, { lines: new Map(everyLine), functions: new Map(), branches: [] });

    const { report: restricted, unrestricted } = await restrictToStatementLines(report, () => COMPONENT);
    const lcov = generateLcov(restricted);

    expect(unrestricted).toEqual([]);
    expect(lcov.split('\n').filter(line => line.startsWith('DA:'))).toEqual([
      'DA:12,0',
      'DA:13,0',
      'DA:14,0',
      'DA:16,0',
      'DA:19,0',
    ]);
    expect(lcov).toContain('LF:5\n');
  });

  it('keeps a file it cannot read whole and names it with the first line of the reason', async () => {
    const report = createCoverageReport();
    const whole = fileCoverage([[1, 0], [2, 1], [3, 0]]);
    report.set('/repo/gone.tsx', whole);
    report.set(UI_FILE, fileCoverage([[11, 0], [12, 1]]));

    const result = await restrictToStatementLines(report, filePath => {
      if (filePath === UI_FILE) return COMPONENT;
      throw new Error('ENOENT: no such file\n    at readFileSync');
    });

    expect(result.report.get('/repo/gone.tsx')).toBe(whole);
    expect(result.report.get(UI_FILE)?.lines).toEqual(new Map([[12, 1]]));
    expect(result.unrestricted).toEqual(['/repo/gone.tsx (ENOENT: no such file)']);
  });

  it('keeps a file whose source does not parse whole', async () => {
    const report = createCoverageReport();
    const whole = fileCoverage([[1, 0]]);
    report.set(CORE_FILE, whole);

    const result = await restrictToStatementLines(report, () => 'export const = ;');

    expect(result.report.get(CORE_FILE)).toBe(whole);
    expect(result.unrestricted).toHaveLength(1);
    expect(result.unrestricted[0]).not.toContain('\n');
  });

  it('restricts a file it cannot compute statements for to its fallback lines', async () => {
    const report = createCoverageReport();
    // A zeroed report: 2 and 4 are lines the bundle has no code for.
    report.set(CORE_FILE, fileCoverage([[1, 1], [2, 0], [3, 0], [4, 0]]));

    const result = await restrictToStatementLines(
      report,
      () => 'export const = ;',
      new Map([[CORE_FILE, new Set([1, 3])]]),
    );

    expect(result.report.get(CORE_FILE)?.lines).toEqual(new Map([[1, 1], [3, 0]]));
    expect(result.unrestricted).toHaveLength(1);
  });
});
