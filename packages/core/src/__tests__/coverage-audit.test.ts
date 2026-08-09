import { describe, it, expect } from 'vitest';
import {
  auditCoverageReport,
  describeCoverageFailure,
  measureZeroFunctionFiles,
} from '../e2e-coverage/audit.js';
import { createCoverageReport } from '../e2e-coverage/collect.js';
import type { CoverageReport, FileCoverage } from '../e2e-coverage/types.js';

interface FileGroup {
  /** How many files of this shape the report holds. */
  count: number;
  /** Path prefix, so the fixtures read like the modules they stand for. */
  prefix: string;
  lines: number;
  functions: number;
  /**
   * Whether the lines are executed. A file V8 reported no functions for comes
   * out fully *covered* (v8-to-istanbul only zeroes lines it was told about),
   * which is precisely what inflates the number.
   */
  covered?: boolean;
}

function fileCoverage(group: FileGroup): FileCoverage {
  const coverage: FileCoverage = { lines: new Map(), functions: new Map(), branches: [] };
  const count = group.covered === false ? 0 : 1;
  for (let line = 1; line <= group.lines; line++) coverage.lines.set(line, count);
  for (let i = 0; i < group.functions; i++) {
    const name = `fn${String(i)}`;
    coverage.functions.set(`${name}:${String(i + 1)}`, { name, line: i + 1, count });
  }
  return coverage;
}

function report(...groups: FileGroup[]): CoverageReport {
  const merged = createCoverageReport();
  // Numbered across all groups, not per group: two groups sharing a prefix
  // would otherwise overwrite each other's keys and silently shrink the
  // report a threshold assertion is counting on.
  let index = 0;
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      merged.set(`${group.prefix}${String(index++)}.ts`, fileCoverage(group));
    }
  }
  return merged;
}

/** Real modules: a few hundred lines each, all with functions in them. */
const modules = (count: number, lines = 30): FileGroup => ({
  count,
  prefix: 'packages/ui/src/module-',
  lines,
  functions: 5,
});

/** The honest baseline — type-only modules genuinely have no functions. */
const typeOnly = (count: number, lines = 40): FileGroup => ({
  count,
  prefix: 'packages/core/src/types/type-',
  lines,
  functions: 0,
});

describe('auditCoverageReport', () => {
  it('passes a healthy report', () => {
    const verdict = auditCoverageReport(report(modules(120, 40)));

    expect(verdict.status).toBe('ok');
    expect(verdict).toMatchObject({ sourceFiles: 120 });
  });

  it('passes the honest baseline of type-only modules', () => {
    // 109 real modules + 11 type-only ones reproduces what every healthy shard
    // measured in CI: 10-11 zero-function files holding 10.7-13.8% of hits.
    const honest = report(modules(109), typeOnly(11));

    const stats = measureZeroFunctionFiles(honest);
    expect(stats.files).toBe(11);
    expect(stats.hitShare).toBeGreaterThan(0.107);
    expect(stats.hitShare).toBeLessThan(0.138);

    expect(auditCoverageReport(honest).status).toBe('ok');
  });

  it('rejects a report where most files have no function records', () => {
    // The CI signature of a lost coverage-attach race: 70 zero-function files
    // credited with two thirds of the shard's covered lines.
    const verdict = auditCoverageReport(
      report(modules(50), { count: 70, prefix: 'packages/ui/src/views/view-', lines: 40, functions: 0 }),
    );

    if (verdict.status !== 'fabricated') {
      throw new Error(`expected a fabricated verdict, got "${verdict.status}"`);
    }
    expect(verdict.sourceFiles).toBe(120);
    expect(verdict.zeroFunction.files).toBe(70);
    expect(verdict.zeroFunction.hitShare).toBeCloseTo(0.651, 3);
  });

  it('rejects an empty report', () => {
    expect(auditCoverageReport(createCoverageReport()).status).toBe('empty');
  });

  it('needs both thresholds blown, not either one', () => {
    // Many zero-function files, but they hold almost none of the coverage.
    const wideButThin = report(modules(400, 100), typeOnly(70, 25));
    expect(measureZeroFunctionFiles(wideButThin).files).toBe(70);
    expect(measureZeroFunctionFiles(wideButThin).hitShare).toBeLessThan(0.3);
    expect(auditCoverageReport(wideButThin).status).toBe('ok');

    // A large share of the coverage, but only a handful of files — a tiny
    // shard that legitimately touched little more than its type modules.
    const narrowButHeavy = report(modules(5), typeOnly(20, 100));
    expect(measureZeroFunctionFiles(narrowButHeavy).files).toBe(20);
    expect(measureZeroFunctionFiles(narrowButHeavy).hitShare).toBeGreaterThan(0.9);
    expect(auditCoverageReport(narrowButHeavy).status).toBe('ok');
  });

  it('ignores short zero-function modules, and counts them once they are not', () => {
    // 20 lines is not suspicious — that is an ordinary constant or barrel file.
    const constants = report(modules(10), typeOnly(60, 20));
    expect(measureZeroFunctionFiles(constants).files).toBe(0);
    expect(auditCoverageReport(constants).status).toBe('ok');

    // One line more and the same files count, which is enough to fail.
    const justOver = report(modules(10), typeOnly(60, 21));
    expect(measureZeroFunctionFiles(justOver).files).toBe(60);
    expect(auditCoverageReport(justOver).status).toBe('fabricated');
  });

  it('measures the share against covered lines, not total lines', () => {
    // The suite barely ran: real modules are present but entirely uncovered,
    // so every hit in the report is fabricated credit.
    const verdict = auditCoverageReport(
      report({ ...modules(200), covered: false }, typeOnly(30)),
    );

    if (verdict.status !== 'fabricated') {
      throw new Error(`expected a fabricated verdict, got "${verdict.status}"`);
    }
    expect(verdict.zeroFunction.hitShare).toBe(1);
  });

  it('does not divide by zero when nothing was covered at all', () => {
    const nothingRan = report({ ...modules(30), covered: false }, { ...typeOnly(30), covered: false });

    const stats = measureZeroFunctionFiles(nothingRan);
    expect(stats.files).toBe(30);
    expect(stats.hitShare).toBe(0);
    // No hits means nothing was inflated — an empty run fails elsewhere, on
    // the suites' own assertions, not as a fabricated report.
    expect(auditCoverageReport(nothingRan).status).toBe('ok');
  });
});

describe('describeCoverageFailure', () => {
  it('explains an empty report', () => {
    expect(describeCoverageFailure({ status: 'empty' })).toContain('no source records');
  });

  it('names the file count, the share and the fix', () => {
    // 50 real + 70 fabricated files at 30 lines each → 2100/3600 hits.
    const verdict = auditCoverageReport(report(modules(50), typeOnly(70, 30)));
    if (verdict.status !== 'fabricated') {
      throw new Error(`expected a fabricated verdict, got "${verdict.status}"`);
    }

    const message = describeCoverageFailure(verdict);
    expect(message).toContain('70 files reported no functions at all');
    expect(message).toContain('58.3%');
    expect(message).toContain('startCoverage(page) immediately after app.firstWindow()');
  });
});
