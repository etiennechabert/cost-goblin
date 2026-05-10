import type { CostResult, TrendResult, SavingsResult, DateRange, FilterMap } from '../types/query.js';
import type { DimensionId } from '../types/branded.js';
import type { InsightParams, TrendSummaryParams, OptimizationParams, ConversationalParams } from './types.js';

/**
 * System prompt that defines the AI's role and constraints for cost analysis.
 * Emphasizes privacy, accuracy, and actionable insights.
 */
const SYSTEM_PROMPT = `You are a FinOps cost analysis assistant for CostGoblin, a privacy-first cloud cost management tool. Your role is to analyze AWS billing data and provide actionable insights.

Key constraints:
- All data is local — never suggest external services or APIs
- Be concise — users want quick insights, not essays
- Focus on actionable recommendations with specific resource types and services
- Include dollar amounts when available to quantify impact
- Use plain language — avoid jargon unless it's standard AWS terminology
- When uncertain, say so — don't invent facts

Output format:
- For trends: 2-3 sentence summary + 3-5 bullet points of key findings
- For optimizations: List of recommendations with estimated savings
- For conversational: Direct answer with supporting data references`;

/**
 * Format a date range for inclusion in prompts.
 */
function formatDateRange(dateRange: DateRange): string {
  return `${dateRange.start} to ${dateRange.end}`;
}

/**
 * Format filters for inclusion in prompts. Returns a human-readable string
 * describing the active filters, or an empty string if no filters.
 */
function formatFilters(filters: FilterMap): string {
  const entries = Object.entries(filters).filter(([, values]) => values !== undefined && values.length > 0);
  if (entries.length === 0) return '';

  const parts = entries.map(([dim, values]) => {
    const valueList = values !== undefined ? values.slice(0, 5).join(', ') : '';
    const more = values !== undefined && values.length > 5 ? ` (+${String(values.length - 5)} more)` : '';
    return `${dim}: ${valueList}${more}`;
  });

  return `Filters applied: ${parts.join('; ')}`;
}

/**
 * Format a dollar amount for prompts. Rounds to 2 decimal places and adds
 * dollar sign.
 */
function formatCost(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

/**
 * Format a CostResult for inclusion in prompts. Includes total cost, top
 * services, and breakdown by entity (up to 10 rows to keep prompt size
 * manageable).
 */
function formatCostResult(result: CostResult, groupBy: DimensionId): string {
  const lines: string[] = [
    `Total cost: ${formatCost(result.totalCost)}`,
    `Date range: ${formatDateRange(result.dateRange)}`,
    `Top services: ${result.topServices.slice(0, 5).join(', ')}`,
    '',
    `Breakdown by ${groupBy}:`,
  ];

  const topRows = result.rows.slice(0, 10);
  for (const row of topRows) {
    const pct = result.totalCost > 0 ? ((row.totalCost / result.totalCost) * 100).toFixed(1) : '0.0';
    lines.push(`  - ${row.entity}: ${formatCost(row.totalCost)} (${pct}%)`);
  }

  if (result.rows.length > 10) {
    lines.push(`  ... and ${String(result.rows.length - 10)} more`);
  }

  return lines.join('\n');
}

/**
 * Format a TrendResult for inclusion in prompts. Includes increases and
 * savings, sorted by impact.
 */
function formatTrendResult(result: TrendResult): string {
  const lines: string[] = [
    `Total increase: ${formatCost(result.totalIncrease)}`,
    `Total savings: ${formatCost(result.totalSavings)}`,
    '',
  ];

  if (result.increases.length > 0) {
    lines.push('Top cost increases:');
    for (const row of result.increases.slice(0, 5)) {
      const pctChange = (row.percentChange * 100).toFixed(1);
      lines.push(`  - ${row.entity}: +${formatCost(row.delta)} (+${pctChange}%)`);
    }
    if (result.increases.length > 5) {
      lines.push(`  ... and ${String(result.increases.length - 5)} more`);
    }
    lines.push('');
  }

  if (result.savings.length > 0) {
    lines.push('Top cost savings:');
    for (const row of result.savings.slice(0, 5)) {
      const pctChange = (row.percentChange * 100).toFixed(1);
      lines.push(`  - ${row.entity}: -${formatCost(Math.abs(row.delta))} (${pctChange}%)`);
    }
    if (result.savings.length > 5) {
      lines.push(`  ... and ${String(result.savings.length - 5)} more`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a SavingsResult for inclusion in prompts. Includes recommendations
 * from Cost Optimization Hub, grouped by effort level.
 */
function formatSavingsResult(result: SavingsResult): string {
  const lines: string[] = [
    `Total potential monthly savings: ${formatCost(result.totalMonthlySavings)}`,
    `Recommendations: ${String(result.recommendations.length)}`,
    '',
  ];

  const byEffort = {
    VeryLow: result.recommendations.filter(r => r.effort === 'VeryLow'),
    Low: result.recommendations.filter(r => r.effort === 'Low'),
    Medium: result.recommendations.filter(r => r.effort === 'Medium'),
    High: result.recommendations.filter(r => r.effort === 'High'),
  };

  for (const [effort, recs] of Object.entries(byEffort)) {
    if (recs.length === 0) continue;

    const totalSavings = recs.reduce((sum, r) => sum + r.monthlySavings, 0);
    lines.push(`${effort} effort (${String(recs.length)} recommendations, ${formatCost(totalSavings)}/month):`);

    for (const rec of recs.slice(0, 3)) {
      lines.push(`  - ${rec.actionType}: ${rec.summary} (${formatCost(rec.monthlySavings)}/month)`);
    }

    if (recs.length > 3) {
      lines.push(`  ... and ${String(recs.length - 3)} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build a prompt for trend summary insight generation.
 */
export function buildTrendSummaryPrompt(
  params: TrendSummaryParams,
  costResult: CostResult,
  trendResult: TrendResult
): string {
  const sections: string[] = [
    SYSTEM_PROMPT,
    '',
    '## Task',
    'Analyze the cost trends for the given date range and provide a concise summary with key findings.',
    '',
    '## Cost Data',
    formatCostResult(costResult, params.groupBy),
    '',
    '## Trend Analysis',
    formatTrendResult(trendResult),
  ];

  const filterDesc = formatFilters(params.filters);
  if (filterDesc !== '') {
    sections.push('', '## Active Filters', filterDesc);
  }

  sections.push(
    '',
    '## Instructions',
    '1. Write a 2-3 sentence summary of the overall trend',
    '2. List 3-5 key findings as bullet points',
    '3. Identify the trend direction: increasing, decreasing, or stable',
    '4. Be specific about which entities and services drove the changes',
    '',
    'Respond in JSON format:',
    '{',
    '  "summary": "Your 2-3 sentence summary here",',
    '  "keyFindings": ["Finding 1", "Finding 2", "Finding 3"],',
    '  "trend": "increasing" | "decreasing" | "stable"',
    '}'
  );

  return sections.join('\n');
}

/**
 * Build a prompt for optimization insight generation.
 */
export function buildOptimizationPrompt(
  params: OptimizationParams,
  costResult: CostResult,
  savingsResult: SavingsResult
): string {
  const sections: string[] = [
    SYSTEM_PROMPT,
    '',
    '## Task',
    'Analyze spending patterns and Cost Optimization Hub recommendations to suggest actionable cost optimizations.',
    '',
    '## Current Spending',
    formatCostResult(costResult, 'service_name' as DimensionId),
    '',
    '## Cost Optimization Hub Recommendations',
    formatSavingsResult(savingsResult),
  ];

  const filterDesc = formatFilters(params.filters);
  if (filterDesc !== '') {
    sections.push('', '## Active Filters', filterDesc);
  }

  sections.push(
    '',
    '## Instructions',
    '1. Review the Cost Optimization Hub recommendations',
    '2. Prioritize based on savings potential and implementation effort',
    '3. Group related recommendations into logical themes',
    '4. Provide 3-5 optimization suggestions with estimated savings',
    '',
    'Respond in JSON format:',
    '{',
    '  "suggestions": [',
    '    {',
    '      "title": "Short title",',
    '      "description": "Detailed explanation with supporting data",',
    '      "estimatedSavings": 1234.56,',
    '      "priority": "high" | "medium" | "low",',
    '      "entities": ["entity-ref-1", "entity-ref-2"] (optional)',
    '    }',
    '  ],',
    '  "totalEstimatedSavings": 1234.56',
    '}'
  );

  return sections.join('\n');
}

/**
 * Build a prompt for conversational insight generation.
 */
export function buildConversationalPrompt(
  params: ConversationalParams,
  costResult: CostResult | null
): string {
  const sections: string[] = [
    SYSTEM_PROMPT,
    '',
    '## Task',
    `Answer the following natural language question about cloud costs: "${params.query}"`,
    '',
  ];

  if (costResult !== null) {
    sections.push(
      '## Cost Data',
      formatCostResult(costResult, 'service_name' as DimensionId),
      ''
    );
  }

  if (params.dateRange !== undefined) {
    sections.push(`Date range: ${formatDateRange(params.dateRange)}`);
  }

  if (params.filters !== undefined) {
    const filterDesc = formatFilters(params.filters);
    if (filterDesc !== '') {
      sections.push(filterDesc);
    }
  }

  sections.push(
    '',
    '## Instructions',
    '1. Provide a direct answer to the question',
    '2. Reference specific data points from the cost data',
    '3. If the data is insufficient to answer fully, say so',
    '4. Include supporting data references (e.g., "Based on S3 spend in us-east-1")',
    '',
    'Respond in JSON format:',
    '{',
    '  "answer": "Your answer here",',
    '  "supportingData": ["Data reference 1", "Data reference 2"] (optional)',
    '}'
  );

  return sections.join('\n');
}

/**
 * Build a prompt for the given insight parameters and query results.
 * This is the main entry point — dispatches to the appropriate builder
 * based on the insight type.
 */
export function buildPrompt(
  params: InsightParams,
  data: {
    readonly costResult?: CostResult | undefined;
    readonly trendResult?: TrendResult | undefined;
    readonly savingsResult?: SavingsResult | undefined;
  }
): string {
  switch (params.type) {
    case 'trend-summary': {
      if (data.costResult === undefined) {
        throw new Error('Cost result required for trend summary insights');
      }
      if (data.trendResult === undefined) {
        throw new Error('Trend result required for trend summary insights');
      }
      return buildTrendSummaryPrompt(params, data.costResult, data.trendResult);
    }

    case 'optimization': {
      if (data.costResult === undefined) {
        throw new Error('Cost result required for optimization insights');
      }
      if (data.savingsResult === undefined) {
        throw new Error('Savings result required for optimization insights');
      }
      return buildOptimizationPrompt(params, data.costResult, data.savingsResult);
    }

    case 'conversational': {
      return buildConversationalPrompt(params, data.costResult ?? null);
    }
  }
}
