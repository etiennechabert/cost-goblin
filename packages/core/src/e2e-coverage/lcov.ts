import type { CoverageReport, FileCoverage } from './types.js';

function fileRecord(filePath: string, coverage: FileCoverage): string {
  const lines: string[] = [];
  lines.push('TN:');
  lines.push(`SF:${filePath}`);

  let functionsHit = 0;
  const functionData: string[] = [];
  for (const fn of coverage.functions.values()) {
    lines.push(`FN:${String(fn.line)},${fn.name}`);
    functionData.push(`FNDA:${String(fn.count)},${fn.name}`);
    if (fn.count > 0) functionsHit++;
  }
  lines.push(`FNF:${String(coverage.functions.size)}`);
  lines.push(`FNH:${String(functionsHit)}`);
  lines.push(...functionData);

  let linesHit = 0;
  for (const [line, count] of [...coverage.lines.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`DA:${String(line)},${String(count)}`);
    if (count > 0) linesHit++;
  }
  lines.push(`LF:${String(coverage.lines.size)}`);
  lines.push(`LH:${String(linesHit)}`);

  // Deduplicate by taking the max count per line+block+branch: a branch shows
  // up once per V8 entry that loaded the file.
  const branches = new Map<string, { line: number; blockId: number; branchId: number; count: number }>();
  for (const branch of coverage.branches) {
    const key = `${String(branch.line)}:${String(branch.blockId)}:${String(branch.branchId)}`;
    const previous = branches.get(key);
    if (previous === undefined || branch.count > previous.count) branches.set(key, branch);
  }
  let branchesHit = 0;
  for (const branch of branches.values()) {
    const count = branch.count > 0 ? String(branch.count) : '-';
    lines.push(
      `BRDA:${String(branch.line)},${String(branch.blockId)},${String(branch.branchId)},${count}`,
    );
    if (branch.count > 0) branchesHit++;
  }
  lines.push(`BRF:${String(branches.size)}`);
  lines.push(`BRH:${String(branchesHit)}`);

  lines.push('end_of_record');
  return lines.join('\n');
}

/**
 * Renders a merged report as lcov.
 *
 * The trailing newline is load-bearing: CI concatenates the per-shard files,
 * and without it the boundary fuses `end_of_record` with the next shard's
 * first line into a corrupt record. It also means an *empty* report renders as
 * a one-byte file rather than an empty one — which CI's `[ -s "$f" ]` merge
 * guard happily accepts, so emptiness has to be rejected separately by
 * `auditCoverageReport`.
 */
export function generateLcov(report: CoverageReport): string {
  const records: string[] = [];
  for (const [filePath, coverage] of report) {
    records.push(fileRecord(filePath, coverage));
  }
  return `${records.join('\n')}\n`;
}
