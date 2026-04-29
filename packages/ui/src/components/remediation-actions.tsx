import { useState } from 'react';
import { Download, Copy } from 'lucide-react';
import type { MissingTagRow } from '@costgoblin/core/browser';
import { formatDollars } from './format.js';

interface RemediationActionsProps {
  readonly selectedRows: readonly MissingTagRow[];
  readonly tagName: string;
}

function escapeCell(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function buildCsv(rows: readonly MissingTagRow[]): string {
  const headers = ['Account ID', 'Account Name', 'Resource ID', 'Service', 'Service Family', 'Cost', 'Suggested Owner'];
  const lines = [headers.map(escapeCell).join(',')];

  for (const row of rows) {
    const cells = [
      escapeCell(row.accountId),
      escapeCell(row.accountName),
      escapeCell(row.resourceId),
      escapeCell(row.service),
      escapeCell(row.serviceFamily),
      String(row.cost),
      escapeCell(row.closestOwner ?? ''),
    ];
    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

function buildIssueTemplate(rows: readonly MissingTagRow[], tagName: string): string {
  const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
  const groupedByOwner = new Map<string, MissingTagRow[]>();

  for (const row of rows) {
    const owner = row.closestOwner ?? 'Unknown';
    const existing = groupedByOwner.get(owner);
    if (existing === undefined) {
      groupedByOwner.set(owner, [row]);
    } else {
      existing.push(row);
    }
  }

  const lines: string[] = [
    `# Missing ${tagName} Tag Remediation`,
    '',
    '## Summary',
    `- **Total untagged resources:** ${rows.length}`,
    `- **Total cost impact:** ${formatDollars(totalCost)}`,
    `- **Tag required:** \`${tagName}\``,
    '',
    '## Resources by Suggested Owner',
    '',
  ];

  const sortedOwners = Array.from(groupedByOwner.entries()).sort((a, b) => {
    const costA = a[1].reduce((sum, r) => sum + r.cost, 0);
    const costB = b[1].reduce((sum, r) => sum + r.cost, 0);
    return costB - costA;
  });

  for (const [owner, ownerRows] of sortedOwners) {
    const ownerCost = ownerRows.reduce((sum, r) => sum + r.cost, 0);
    lines.push(`### ${owner} (${formatDollars(ownerCost)})`);
    lines.push('');
    for (const row of ownerRows) {
      lines.push(`- **Resource:** \`${row.resourceId}\``);
      lines.push(`  - Account: ${row.accountName} (\`${row.accountId}\`)`);
      lines.push(`  - Service: ${row.service} (${row.serviceFamily})`);
      lines.push(`  - Cost: ${formatDollars(row.cost)}`);
      lines.push('');
    }
  }

  lines.push('## Action Items');
  lines.push('');
  lines.push('- [ ] Review resource ownership assignments');
  lines.push('- [ ] Add required tags to all resources');
  lines.push('- [ ] Verify tags are correctly applied');
  lines.push('- [ ] Update runbooks if needed');

  return lines.join('\n');
}

export function RemediationActions({ selectedRows, tagName }: Readonly<RemediationActionsProps>) {
  const [copied, setCopied] = useState(false);

  function handleExportCsv() {
    const csv = buildCsv(selectedRows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `missing-${tagName}-remediation.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleCopyIssue(): Promise<void> {
    const issueBody = buildIssueTemplate(selectedRows, tagName);
    await navigator.clipboard.writeText(issueBody);
    setCopied(true);
    setTimeout(() => { setCopied(false); }, 1500);
  }

  if (selectedRows.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleExportCsv}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
      >
        <Download size={14} />
        Export CSV
      </button>
      <button
        type="button"
        onClick={() => { void handleCopyIssue(); }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary/50 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-colors"
      >
        <Copy size={14} />
        {copied ? 'Copied!' : 'Copy Issue Template'}
      </button>
      <span className="text-xs text-text-muted">
        {selectedRows.length} {selectedRows.length === 1 ? 'resource' : 'resources'} selected
      </span>
    </div>
  );
}
