import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { RemediationActions } from '../components/remediation-actions.js';
import { asDollars } from '@costgoblin/core/browser';
import type { MissingTagRow } from '@costgoblin/core/browser';

const mockRows: MissingTagRow[] = [
  {
    accountId: '123456789012',
    accountName: 'prod-main',
    resourceId: 'i-0abc123def456gh78',
    service: 'Amazon EC2',
    serviceFamily: 'Compute',
    cost: asDollars(1_200),
    closestOwner: 'platform' as never,
    bucket: 'actionable',
    categoryTaggedRatio: 0.82,
  },
  {
    accountId: '234567890123',
    accountName: 'prod-data',
    resourceId: 'arn:aws:rds:us-east-1:234567890123:db:analytics-prod',
    service: 'Amazon RDS',
    serviceFamily: 'Database',
    cost: asDollars(870),
    closestOwner: 'data' as never,
    bucket: 'actionable',
    categoryTaggedRatio: 0.65,
  },
];

afterEach(cleanup);

describe('RemediationActions', () => {
  it('returns null when no rows selected', () => {
    const { container } = render(
      <RemediationActions selectedRows={[]} tagName="team" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows export CSV button when rows are selected', () => {
    render(
      <RemediationActions selectedRows={mockRows} tagName="team" />,
    );
    expect(screen.getByText('Export CSV')).toBeDefined();
  });

  it('shows copy issue template button when rows are selected', () => {
    render(
      <RemediationActions selectedRows={mockRows} tagName="team" />,
    );
    expect(screen.getByText('Copy Issue Template')).toBeDefined();
  });

  it('displays correct count for single resource', () => {
    render(
      <RemediationActions selectedRows={[mockRows[0]!]} tagName="team" />,
    );
    expect(screen.getByText('1 resource selected')).toBeDefined();
  });

  it('displays correct count for multiple resources', () => {
    render(
      <RemediationActions selectedRows={mockRows} tagName="team" />,
    );
    expect(screen.getByText('2 resources selected')).toBeDefined();
  });
});
