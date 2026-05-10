import {
  buildCostQuery,
  buildTrendQuery,
  logger,
  asDollars,
} from '@costgoblin/core';
import type { DateRange, DimensionId } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { formatDollars } from '../formatters/cost.js';
import { truncateRows, truncateFooter } from '../formatters/cost.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import {
  buildQueryContextOpts,
  defaultDateRange,
  lookupDimension,
  resolveEntityName,
  toDateRange,
  toFilterMap,
  toNum,
  toStr,
  toolError,
  toolResult,
} from './tool-helpers.js';

interface QueryIntent {
  readonly type: 'cost' | 'trend' | 'comparison';
  readonly groupBy: DimensionId;
  readonly dateRange: DateRange;
  readonly filters: Record<string, readonly string[]>;
  readonly entities: readonly string[];
}

/**
 * Parse a natural language query and extract structured intent.
 * This is a simple keyword-based parser that looks for common patterns.
 */
function parseQuery(query: string): QueryIntent {
  const lowerQuery = query.toLowerCase();

  // Detect dimension to group by
  let groupBy: DimensionId = 'service' as DimensionId;
  if (lowerQuery.includes('account') || lowerQuery.includes('accounts')) {
    groupBy = 'account' as DimensionId;
  } else if (lowerQuery.includes('region')) {
    groupBy = 'region' as DimensionId;
  } else if (lowerQuery.includes('team')) {
    groupBy = 'tag_team' as DimensionId;
  } else if (lowerQuery.includes('environment') || lowerQuery.includes('env')) {
    groupBy = 'tag_environment' as DimensionId;
  } else if (lowerQuery.includes('service')) {
    groupBy = 'service' as DimensionId;
  }

  // Detect time period
  let dateRange = defaultDateRange();
  const now = Date.now();
  const dayMs = 86_400_000;

  if (lowerQuery.includes('last week')) {
    const end = new Date(now - 7 * dayMs);
    const start = new Date(end.getTime() - 6 * dayMs);
    dateRange = toDateRange({
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });
  } else if (lowerQuery.includes('last month')) {
    const today = new Date(now);
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    dateRange = toDateRange({
      start: lastMonth.toISOString().slice(0, 10),
      end: lastMonthEnd.toISOString().slice(0, 10),
    });
  } else if (lowerQuery.includes('this month')) {
    const today = new Date(now);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    dateRange = toDateRange({
      start: monthStart.toISOString().slice(0, 10),
      end: today.toISOString().slice(0, 10),
    });
  } else if (lowerQuery.includes('last 7 days')) {
    const end = new Date(now - dayMs);
    const start = new Date(end.getTime() - 6 * dayMs);
    dateRange = toDateRange({
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });
  }

  // Detect entity filters (e.g., "s3", "ec2", etc.)
  const entities: string[] = [];
  const serviceKeywords = ['s3', 'ec2', 'rds', 'lambda', 'dynamodb', 'cloudfront', 'elb', 'vpc'];
  for (const keyword of serviceKeywords) {
    if (lowerQuery.includes(keyword)) {
      entities.push(keyword.toUpperCase());
    }
  }

  // Detect query type
  let type: 'cost' | 'trend' | 'comparison' = 'cost';
  if (
    lowerQuery.includes('increase') ||
    lowerQuery.includes('decrease') ||
    lowerQuery.includes('change') ||
    lowerQuery.includes('trend') ||
    lowerQuery.includes('went up') ||
    lowerQuery.includes('went down')
  ) {
    type = 'trend';
  } else if (lowerQuery.includes('compare') || lowerQuery.includes('vs') || lowerQuery.includes('versus')) {
    type = 'comparison';
  }

  const filters: Record<string, readonly string[]> = {};
  if (entities.length > 0 && groupBy === 'service') {
    // If asking about specific services, filter by them instead of grouping
    filters['service'] = entities;
    // Switch groupBy to account if asking about services
    groupBy = 'account' as DimensionId;
  }

  return { type, groupBy, dateRange, filters, entities };
}

export async function aiQuery(
  ctx: McpContext,
  params: {
    query: string;
  },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const { query } = params;

  logger.info('ai-query', { query });

  // Parse the natural language query
  const intent = parseQuery(query);
  const { type, groupBy, dateRange, filters } = intent;

  const { opts, empty } = await buildQueryContextOpts(ctx, dateRange);
  if (empty) {
    return toolError(`No data available for ${dateRange.start} to ${dateRange.end}.`);
  }

  const filterMap = toFilterMap(filters);

  // Execute query based on detected intent
  if (type === 'trend') {
    // Run trend comparison query
    const { sql, params: queryParams } = buildTrendQuery(
      { groupBy, dateRange, filters: filterMap, deltaThreshold: asDollars(1), percentThreshold: 5 },
      opts,
    );
    const rows = await ctx.runPreparedQuery(sql, queryParams);

    const accountMap = (groupBy === 'account' || groupBy === 'account_id')
      ? await ctx.getAccountMap()
      : new Map<string, string>();

    const increases: { entity: string; current: number; previous: number; delta: number; percent: number }[] = [];
    const decreases: { entity: string; current: number; previous: number; delta: number; percent: number }[] = [];

    for (const row of rows) {
      const entity = resolveEntityName(toStr(row['entity']), accountMap);
      const current = toNum(row['current_cost']);
      const previous = toNum(row['previous_cost']);
      const delta = toNum(row['delta']);
      const percent = toNum(row['percent_change']);

      if (Math.abs(delta) < 1) continue; // Skip small changes

      if (delta > 0) {
        increases.push({ entity, current, previous, delta, percent });
      } else {
        decreases.push({ entity, current, previous, delta: Math.abs(delta), percent: Math.abs(percent) });
      }
    }

    increases.sort((a, b) => b.delta - a.delta);
    decreases.sort((a, b) => b.delta - a.delta);

    const { label: dimLabel } = lookupDimension(groupBy, opts.dimensions);

    const sections: string[] = [];
    sections.push(`## Cost Trends by ${dimLabel}`);
    sections.push('');
    sections.push(`**Query**: "${query}"`);
    sections.push(`**Period**: ${dateRange.start} to ${dateRange.end} vs previous period`);
    sections.push('');

    if (increases.length > 0) {
      sections.push('### Top Cost Increases');
      sections.push('');
      const increaseColumns: ColumnDef[] = [
        { header: dimLabel },
        { header: 'Current', align: 'right' },
        { header: 'Previous', align: 'right' },
        { header: 'Change', align: 'right' },
        { header: '% Change', align: 'right' },
      ];
      const increaseRows = increases.slice(0, 10).map(r => [
        r.entity,
        formatDollars(r.current),
        formatDollars(r.previous),
        `+${formatDollars(r.delta)}`,
        `+${r.percent.toFixed(1)}%`,
      ]);
      sections.push(markdownTable(increaseColumns, increaseRows));
      sections.push('');
    }

    if (decreases.length > 0) {
      sections.push('### Top Cost Decreases');
      sections.push('');
      const decreaseColumns: ColumnDef[] = [
        { header: dimLabel },
        { header: 'Current', align: 'right' },
        { header: 'Previous', align: 'right' },
        { header: 'Change', align: 'right' },
        { header: '% Change', align: 'right' },
      ];
      const decreaseRows = decreases.slice(0, 10).map(r => [
        r.entity,
        formatDollars(r.current),
        formatDollars(r.previous),
        `-${formatDollars(r.delta)}`,
        `-${r.percent.toFixed(1)}%`,
      ]);
      sections.push(markdownTable(decreaseColumns, decreaseRows));
      sections.push('');
    }

    if (increases.length === 0 && decreases.length === 0) {
      sections.push('No significant cost changes detected (threshold: $1).');
    }

    return toolResult(sections.join('\n'));
  } else {
    // Run standard cost query
    const { sql, params: queryParams } = buildCostQuery(
      { groupBy, dateRange, filters: filterMap },
      opts,
    );
    const rows = await ctx.runPreparedQuery(sql, queryParams);

    const entityMap = new Map<string, { totalCost: number; serviceCosts: Record<string, number> }>();
    const serviceTotals = new Map<string, number>();

    for (const row of rows) {
      const entity = toStr(row['entity']);
      const totalCost = toNum(row['total_cost']);
      const service = typeof row['service'] === 'string' ? row['service'] : null;
      const serviceCost = toNum(row['service_cost']);

      if (!entityMap.has(entity)) {
        entityMap.set(entity, { totalCost, serviceCosts: {} });
      }
      if (service !== null && service.length > 0) {
        const entry = entityMap.get(entity);
        if (entry !== undefined) entry.serviceCosts[service] = serviceCost;
        serviceTotals.set(service, (serviceTotals.get(service) ?? 0) + serviceCost);
      }
    }

    const accountMap = (groupBy === 'account' || groupBy === 'account_id')
      ? await ctx.getAccountMap()
      : new Map<string, string>();

    const costRows: { entity: string; totalCost: number; serviceCosts: Record<string, number> }[] = [];
    let grandTotal = 0;
    for (const [entity, data] of entityMap) {
      const name = resolveEntityName(entity, accountMap);
      costRows.push({ entity: name, totalCost: data.totalCost, serviceCosts: data.serviceCosts });
      grandTotal += data.totalCost;
    }
    costRows.sort((a, b) => b.totalCost - a.totalCost);

    const topServices = [...serviceTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    const { label: dimLabel } = lookupDimension(groupBy, opts.dimensions);

    const columns: ColumnDef[] = [
      { header: dimLabel },
      { header: 'Cost', align: 'right' },
      { header: '% Total', align: 'right' },
      ...topServices.map(s => ({ header: s, align: 'right' as const })),
    ];

    const limit = 15;
    const { visible, hiddenCount, hiddenCost } = truncateRows(costRows, limit, r => r.totalCost);

    const tableRows = visible.map(r => [
      r.entity,
      formatDollars(r.totalCost),
      grandTotal > 0 ? `${((r.totalCost / grandTotal) * 100).toFixed(1)}%` : '0%',
      ...topServices.map(s => formatDollars(r.serviceCosts[s] ?? 0)),
    ]);

    const sections: string[] = [];
    sections.push(`## Cost Analysis by ${dimLabel}`);
    sections.push('');
    sections.push(`**Query**: "${query}"`);
    sections.push(`**Period**: ${dateRange.start} to ${dateRange.end}`);
    sections.push(`**Total Cost**: ${formatDollars(grandTotal)}`);
    sections.push('');
    sections.push(markdownTable(columns, tableRows));
    sections.push(truncateFooter(hiddenCount, hiddenCost));

    return toolResult(sections.join('\n'));
  }
}
