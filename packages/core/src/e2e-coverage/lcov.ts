import type { CoverageReport, FileCoverage } from './types.js';

/** The function key is `name:line`; the name is everything before the colon. */
function functionName(key: string): string {
  return key.split(':')[0] ?? key;
}

function fileRecord(filePath: string, coverage: FileCoverage): string {
  const lines: string[] = [];
  lines.push('TN:');
  lines.push(`SF:${filePath}`);

  for (const [key, fn] of coverage.functions) {
    lines.push(`FN:${String(fn.line)},${functionName(key)}`);
  }
  lines.push(`FNF:${String(coverage.functions.size)}`);
  const functionsHit = [...coverage.functions.values()].filter(fn => fn.count > 0).length;
  lines.push(`FNH:${String(functionsHit)}`);
  for (const [key, fn] of coverage.functions) {
    lines.push(`FNDA:${String(fn.count)},${functionName(key)}`);
  }

  let linesHit = 0;
  for (const [line, count] of [...coverage.lines.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`DA:${String(line)},${String(count)}`);
    if (count > 0) linesHit++;
  }
  lines.push(`LF:${String(coverage.lines.size)}`);
  lines.push(`LH:${String(linesHit)}`);

  // Deduplicate by taking the max count per line+block+branch: a branch shows
  // up once per shard that loaded the file.
  const branches = new Map<string, number>();
  for (const branch of coverage.branches) {
    const key = `${String(branch.line)}:${String(branch.blockId)}:${String(branch.branchId)}`;
    branches.set(key, Math.max(branches.get(key) ?? 0, branch.count));
  }
  let branchesHit = 0;
  for (const [key, count] of branches) {
    const [line, block, branch] = key.split(':');
    lines.push(
      `BRDA:${line ?? '0'},${block ?? '0'},${branch ?? '0'},${count > 0 ? String(count) : '-'}`,
    );
    if (count > 0) branchesHit++;
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
