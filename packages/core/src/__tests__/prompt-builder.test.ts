import { describe, it, expect } from 'vitest';
import { buildPrompt, buildTrendSummaryPrompt, buildOptimizationPrompt, buildConversationalPrompt } from '../ai/prompt-builder.js';
import type { CostResult, TrendResult, SavingsResult } from '../types/query.js';
import type { TrendSummaryParams, OptimizationParams, ConversationalParams } from '../ai/types.js';
import { asDimensionId, asEntityRef, asDollars, asDateString, asTagValue } from '../types/branded.js';

describe('Prompt builder - trend summary', () => {
  const params: TrendSummaryParams = {
    type: 'trend-summary',
    dateRange: {
      start: asDateString('2026-04-01'),
      end: asDateString('2026-04-30'),
    },
    filters: {
      [asDimensionId('account_id')]: [asTagValue('123456789012')],
    },
    groupBy: asDimensionId('service_name'),
  };

  const costResult: CostResult = {
    rows: [
      {
        entity: asEntityRef('EC2'),
        totalCost: asDollars(1200.50),
        serviceCosts: { 'EC2': asDollars(1200.50) },
      },
      {
        entity: asEntityRef('S3'),
        totalCost: asDollars(850.25),
        serviceCosts: { 'S3': asDollars(850.25) },
      },
      {
        entity: asEntityRef('RDS'),
        totalCost: asDollars(450.00),
        serviceCosts: { 'RDS': asDollars(450.00) },
      },
    ],
    totalCost: asDollars(2500.75),
    topServices: ['EC2', 'S3', 'RDS'],
    dateRange: params.dateRange,
  };

  const trendResult: TrendResult = {
    increases: [
      {
        entity: asEntityRef('EC2'),
        currentCost: asDollars(1200.50),
        previousCost: asDollars(900.00),
        delta: asDollars(300.50),
        percentChange: 0.3339,
      },
    ],
    savings: [
      {
        entity: asEntityRef('S3'),
        currentCost: asDollars(850.25),
        previousCost: asDollars(1000.00),
        delta: asDollars(-149.75),
        percentChange: -0.14975,
      },
    ],
    totalIncrease: asDollars(300.50),
    totalSavings: asDollars(149.75),
  };

  it('includes system prompt', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('FinOps cost analysis assistant');
    expect(prompt).toContain('privacy-first');
  });

  it('includes date range', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('2026-04-01 to 2026-04-30');
  });

  it('includes total cost', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('$2500.75');
  });

  it('includes top services', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('EC2');
    expect(prompt).toContain('S3');
    expect(prompt).toContain('RDS');
  });

  it('includes breakdown by entity', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('EC2: $1200.50');
    expect(prompt).toContain('S3: $850.25');
    expect(prompt).toContain('RDS: $450.00');
  });

  it('includes trend increases', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('Top cost increases');
    expect(prompt).toContain('+$300.50');
    expect(prompt).toContain('+33.4%');
  });

  it('includes trend savings', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('Top cost savings');
    expect(prompt).toContain('-$149.75');
    expect(prompt).toContain('-15.0%');
  });

  it('includes active filters', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('Filters applied');
    expect(prompt).toContain('account_id: 123456789012');
  });

  it('includes JSON format instructions', () => {
    const prompt = buildTrendSummaryPrompt(params, costResult, trendResult);
    expect(prompt).toContain('Respond in JSON format');
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"keyFindings"');
    expect(prompt).toContain('"trend"');
  });

  it('limits breakdown to 10 rows', () => {
    const manyRows: CostResult = {
      ...costResult,
      rows: Array.from({ length: 15 }, (_, i) => ({
        entity: asEntityRef(`Service${String(i + 1)}`),
        totalCost: asDollars(100),
        serviceCosts: { [`Service${String(i + 1)}`]: asDollars(100) },
      })),
    };

    const prompt = buildTrendSummaryPrompt(params, manyRows, trendResult);
    expect(prompt).toContain('and 5 more');
  });

  it('omits filters section when no filters applied', () => {
    const noFilterParams: TrendSummaryParams = {
      ...params,
      filters: {},
    };

    const prompt = buildTrendSummaryPrompt(noFilterParams, costResult, trendResult);
    expect(prompt).not.toContain('Filters applied');
  });

  it('truncates filter values when more than 5', () => {
    const manyFilterParams: TrendSummaryParams = {
      ...params,
      filters: {
        [asDimensionId('account_id')]: [asTagValue('acc1'), asTagValue('acc2'), asTagValue('acc3'), asTagValue('acc4'), asTagValue('acc5'), asTagValue('acc6'), asTagValue('acc7')],
      },
    };

    const prompt = buildTrendSummaryPrompt(manyFilterParams, costResult, trendResult);
    expect(prompt).toContain('(+2 more)');
  });
});

describe('Prompt builder - optimization', () => {
  const params: OptimizationParams = {
    type: 'optimization',
    dateRange: {
      start: asDateString('2026-04-01'),
      end: asDateString('2026-04-30'),
    },
    filters: {},
    minCost: 100,
  };

  const costResult: CostResult = {
    rows: [
      {
        entity: asEntityRef('EC2'),
        totalCost: asDollars(5000),
        serviceCosts: { 'EC2': asDollars(5000) },
      },
      {
        entity: asEntityRef('RDS'),
        totalCost: asDollars(3000),
        serviceCosts: { 'RDS': asDollars(3000) },
      },
    ],
    totalCost: asDollars(8000),
    topServices: ['EC2', 'RDS'],
    dateRange: params.dateRange,
  };

  const savingsResult: SavingsResult = {
    recommendations: [
      {
        accountId: '123456789012',
        accountName: 'prod-account',
        actionType: 'Rightsize',
        resourceType: 'EC2 Instance',
        summary: 'Underutilized t3.large instance',
        region: 'us-east-1',
        monthlySavings: asDollars(240),
        monthlyCost: asDollars(600),
        savingsPercentage: 40,
        effort: 'Low',
        resourceArn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-1234567890abcdef0',
        currentDetails: 't3.large with 5% CPU utilization',
        recommendedDetails: 't3.medium',
        currentSummary: 'Running t3.large',
        restartNeeded: true,
        rollbackPossible: true,
        recommendationSource: 'Cost Optimization Hub',
      },
      {
        accountId: '123456789012',
        accountName: 'prod-account',
        actionType: 'Stop',
        resourceType: 'RDS Instance',
        summary: 'Idle RDS instance',
        region: 'us-west-2',
        monthlySavings: asDollars(450),
        monthlyCost: asDollars(450),
        savingsPercentage: 100,
        effort: 'VeryLow',
        resourceArn: 'arn:aws:rds:us-west-2:123456789012:db:my-db',
        currentDetails: 'No connections in 30 days',
        recommendedDetails: 'Stop or delete',
        currentSummary: 'Running with no connections',
        restartNeeded: false,
        rollbackPossible: true,
        recommendationSource: 'Cost Optimization Hub',
      },
    ],
    totalMonthlySavings: asDollars(690),
  };

  it('includes system prompt', () => {
    const prompt = buildOptimizationPrompt(params, costResult, savingsResult);
    expect(prompt).toContain('FinOps cost analysis assistant');
  });

  it('includes current spending', () => {
    const prompt = buildOptimizationPrompt(params, costResult, savingsResult);
    expect(prompt).toContain('Current Spending');
    expect(prompt).toContain('$8000.00');
  });

  it('includes total potential savings', () => {
    const prompt = buildOptimizationPrompt(params, costResult, savingsResult);
    expect(prompt).toContain('$690.00');
  });

  it('includes recommendations grouped by effort', () => {
    const prompt = buildOptimizationPrompt(params, costResult, savingsResult);
    expect(prompt).toContain('VeryLow effort');
    expect(prompt).toContain('Low effort');
  });

  it('includes recommendation details', () => {
    const prompt = buildOptimizationPrompt(params, costResult, savingsResult);
    expect(prompt).toContain('Rightsize');
    expect(prompt).toContain('Underutilized t3.large instance');
    expect(prompt).toContain('$240.00');
  });

  it('includes JSON format instructions', () => {
    const prompt = buildOptimizationPrompt(params, costResult, savingsResult);
    expect(prompt).toContain('Respond in JSON format');
    expect(prompt).toContain('"suggestions"');
    expect(prompt).toContain('"estimatedSavings"');
    expect(prompt).toContain('"priority"');
  });

  it('limits recommendations to 3 per effort level', () => {
    const manyRecs: SavingsResult = {
      recommendations: Array.from({ length: 5 }, (_, i) => ({
        accountId: '123456789012',
        accountName: 'prod-account',
        actionType: 'Rightsize',
        resourceType: 'EC2 Instance',
        summary: `Instance ${String(i + 1)}`,
        region: 'us-east-1',
        monthlySavings: asDollars(100),
        monthlyCost: asDollars(200),
        savingsPercentage: 50,
        effort: 'Low' as const,
        resourceArn: `arn:aws:ec2:us-east-1:123456789012:instance/i-${String(i)}`,
        currentDetails: 'Details',
        recommendedDetails: 'Recommended',
        currentSummary: 'Summary',
        restartNeeded: true,
        rollbackPossible: true,
        recommendationSource: 'Cost Optimization Hub',
      })),
      totalMonthlySavings: asDollars(500),
    };

    const prompt = buildOptimizationPrompt(params, costResult, manyRecs);
    expect(prompt).toContain('and 2 more');
  });
});

describe('Prompt builder - conversational', () => {
  const dateRange = {
    start: asDateString('2026-04-01'),
    end: asDateString('2026-04-30'),
  };

  const params: ConversationalParams = {
    type: 'conversational',
    query: 'Which team spent the most on S3 last month?',
    dateRange,
    filters: {
      [asDimensionId('service_name')]: [asTagValue('S3')],
    },
  };

  const costResult: CostResult = {
    rows: [
      {
        entity: asEntityRef('team-alpha'),
        totalCost: asDollars(1500),
        serviceCosts: { 'S3': asDollars(1500) },
      },
      {
        entity: asEntityRef('team-beta'),
        totalCost: asDollars(900),
        serviceCosts: { 'S3': asDollars(900) },
      },
    ],
    totalCost: asDollars(2400),
    topServices: ['S3'],
    dateRange,
  };

  it('includes system prompt', () => {
    const prompt = buildConversationalPrompt(params, costResult);
    expect(prompt).toContain('FinOps cost analysis assistant');
  });

  it('includes user query', () => {
    const prompt = buildConversationalPrompt(params, costResult);
    expect(prompt).toContain('Which team spent the most on S3 last month?');
  });

  it('includes cost data when provided', () => {
    const prompt = buildConversationalPrompt(params, costResult);
    expect(prompt).toContain('Cost Data');
    expect(prompt).toContain('team-alpha');
    expect(prompt).toContain('$1500.00');
  });

  it('includes date range when provided', () => {
    const prompt = buildConversationalPrompt(params, costResult);
    expect(prompt).toContain('2026-04-01 to 2026-04-30');
  });

  it('includes filters when provided', () => {
    const prompt = buildConversationalPrompt(params, costResult);
    expect(prompt).toContain('service_name: S3');
  });

  it('handles null cost result', () => {
    const prompt = buildConversationalPrompt(params, null);
    expect(prompt).not.toContain('Cost Data');
    expect(prompt).toContain('Which team spent the most on S3 last month?');
  });

  it('handles missing date range', () => {
    const noDateParams: ConversationalParams = {
      type: 'conversational',
      query: 'What are the top services?',
    };

    const prompt = buildConversationalPrompt(noDateParams, costResult);
    expect(prompt).toContain('What are the top services?');
  });

  it('includes JSON format instructions', () => {
    const prompt = buildConversationalPrompt(params, costResult);
    expect(prompt).toContain('Respond in JSON format');
    expect(prompt).toContain('"answer"');
    expect(prompt).toContain('"supportingData"');
  });
});

describe('Prompt builder - buildPrompt dispatcher', () => {
  const dateRange = {
    start: asDateString('2026-04-01'),
    end: asDateString('2026-04-30'),
  };

  const costResult: CostResult = {
    rows: [],
    totalCost: asDollars(0),
    topServices: [],
    dateRange,
  };

  const trendResult: TrendResult = {
    increases: [],
    savings: [],
    totalIncrease: asDollars(0),
    totalSavings: asDollars(0),
  };

  const savingsResult: SavingsResult = {
    recommendations: [],
    totalMonthlySavings: asDollars(0),
  };

  it('dispatches to trend summary builder', () => {
    const params: TrendSummaryParams = {
      type: 'trend-summary',
      dateRange,
      filters: {},
      groupBy: asDimensionId('service_name'),
    };

    const prompt = buildPrompt(params, { costResult, trendResult });
    expect(prompt).toContain('Analyze the cost trends');
  });

  it('dispatches to optimization builder', () => {
    const params: OptimizationParams = {
      type: 'optimization',
      dateRange,
      filters: {},
      minCost: 100,
    };

    const prompt = buildPrompt(params, { costResult, savingsResult });
    expect(prompt).toContain('Cost Optimization Hub');
  });

  it('dispatches to conversational builder', () => {
    const params: ConversationalParams = {
      type: 'conversational',
      query: 'Test query',
    };

    const prompt = buildPrompt(params, { costResult });
    expect(prompt).toContain('Test query');
  });

  it('throws when cost result missing for trend summary', () => {
    const params: TrendSummaryParams = {
      type: 'trend-summary',
      dateRange,
      filters: {},
      groupBy: asDimensionId('service_name'),
    };

    expect(() => buildPrompt(params, { trendResult })).toThrow(
      'Cost result required for trend summary insights'
    );
  });

  it('throws when trend result missing for trend summary', () => {
    const params: TrendSummaryParams = {
      type: 'trend-summary',
      dateRange,
      filters: {},
      groupBy: asDimensionId('service_name'),
    };

    expect(() => buildPrompt(params, { costResult })).toThrow(
      'Trend result required for trend summary insights'
    );
  });

  it('throws when cost result missing for optimization', () => {
    const params: OptimizationParams = {
      type: 'optimization',
      dateRange,
      filters: {},
      minCost: 100,
    };

    expect(() => buildPrompt(params, { savingsResult })).toThrow(
      'Cost result required for optimization insights'
    );
  });

  it('throws when savings result missing for optimization', () => {
    const params: OptimizationParams = {
      type: 'optimization',
      dateRange,
      filters: {},
      minCost: 100,
    };

    expect(() => buildPrompt(params, { costResult })).toThrow(
      'Savings result required for optimization insights'
    );
  });

  it('handles conversational without cost result', () => {
    const params: ConversationalParams = {
      type: 'conversational',
      query: 'Test query',
    };

    const prompt = buildPrompt(params, {});
    expect(prompt).toContain('Test query');
  });
});
