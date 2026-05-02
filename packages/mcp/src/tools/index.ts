import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from '../context.js';
import { getCostOverview } from './get-cost-overview.js';
import { listDimensions } from './list-dimensions.js';
import { getFilterValues } from './get-filter-values.js';
import { queryCosts } from './query-costs.js';
import { queryDailyCosts } from './query-daily-costs.js';
import { queryTrends } from './query-trends.js';
import { queryEntityDetail } from './query-entity-detail.js';
import { queryMissingTags } from './query-missing-tags.js';
import { exploreData } from './explore-data.js';
import { runSql } from './run-sql.js';
import { toolError } from './tool-helpers.js';

const dateRangeSchema = z.object({
  start: z.string().describe('Start date (YYYY-MM-DD)'),
  end: z.string().describe('End date (YYYY-MM-DD)'),
}).optional();

const filtersSchema = z.record(z.string(), z.array(z.string())).optional()
  .describe('Filter map: dimension ID -> array of values to include');

export function registerTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'get_cost_overview',
    {
      description: 'Get a high-level overview of cloud costs: total spend, top services, top accounts, available dimensions. Start here.',
      inputSchema: {
        dateRange: dateRangeSchema,
      },
    },
    async (params) => {
      try {
        return await getCostOverview(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'list_dimensions',
    {
      description: 'List all available dimensions (groupBy/filter fields) with their IDs, labels, types, and descriptions.',
    },
    async () => {
      try {
        return await listDimensions(ctx);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_filter_values',
    {
      description: 'Get all values for a dimension with their cost contribution. Useful for discovering what to filter on.',
      inputSchema: {
        dimensionId: z.string().describe('Dimension ID (from list_dimensions)'),
        dateRange: dateRangeSchema,
        filters: filtersSchema,
        limit: z.number().optional().describe('Max values to return (default 50)'),
      },
    },
    async (params) => {
      try {
        return await getFilterValues(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'query_costs',
    {
      description: 'Break down costs by any dimension. Returns entity table with total cost, percentage, and top-5 service columns.',
      inputSchema: {
        groupBy: z.string().describe('Dimension ID to group by (e.g. "service", "account", "region", or a tag column)'),
        dateRange: dateRangeSchema,
        filters: filtersSchema,
        limit: z.number().optional().describe('Max rows to return (default 15)'),
      },
    },
    async (params) => {
      try {
        return await queryCosts(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'query_daily_costs',
    {
      description: 'Time series of daily (or weekly if window > 14 days) costs broken down by a dimension. Shows top 5 groups.',
      inputSchema: {
        groupBy: z.string().optional().describe('Dimension ID to group by (default: "service")'),
        dateRange: dateRangeSchema,
        filters: filtersSchema,
      },
    },
    async (params) => {
      try {
        return await queryDailyCosts(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'query_trends',
    {
      description: 'Compare current period vs previous period. Shows top increases and savings with delta and % change.',
      inputSchema: {
        groupBy: z.string().describe('Dimension ID to group by'),
        dateRange: dateRangeSchema,
        filters: filtersSchema,
        deltaThreshold: z.number().optional().describe('Min absolute delta to include (default $1)'),
        percentThreshold: z.number().optional().describe('Min % change to include (default 5%)'),
        limit: z.number().optional().describe('Max rows per section (default 15)'),
      },
    },
    async (params) => {
      try {
        return await queryTrends(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'query_entity_detail',
    {
      description: 'Deep dive on a single entity: total cost, service breakdown, account breakdown, daily trend.',
      inputSchema: {
        entity: z.string().describe('Entity value (e.g. account name, service name, tag value)'),
        dimension: z.string().describe('Dimension ID the entity belongs to'),
        dateRange: dateRangeSchema,
        filters: filtersSchema,
      },
    },
    async (params) => {
      try {
        return await queryEntityDetail(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'query_missing_tags',
    {
      description: 'Find untagged resources and their cost. Shows actionable (taggable) vs likely-untaggable breakdown.',
      inputSchema: {
        tagDimension: z.string().describe('Tag dimension ID to check (e.g. "tag_team", "tag_environment")'),
        dateRange: dateRangeSchema,
        filters: filtersSchema,
        minCost: z.number().optional().describe('Min cost per resource to include (default $10)'),
        limit: z.number().optional().describe('Max resources to show (default 20)'),
      },
    },
    async (params) => {
      try {
        return await queryMissingTags(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'explore_data',
    {
      description: 'Browse raw CUR line items or aggregated data. Use groupByColumns for aggregation, omit for raw rows.',
      inputSchema: {
        dateRange: dateRangeSchema,
        filters: filtersSchema,
        groupByColumns: z.array(z.string()).optional()
          .describe('Columns to GROUP BY for aggregation (e.g. ["service", "region"]). Omit for raw rows.'),
        sort: z.object({
          column: z.string(),
          direction: z.enum(['asc', 'desc']),
        }).optional().describe('Sort order'),
        limit: z.number().optional().describe('Max rows (default 50, max 200)'),
      },
    },
    async (params) => {
      try {
        return await exploreData(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'run_sql',
    {
      description: 'Run an ad-hoc SELECT query. A "costs" CTE is pre-defined with the dataset for the given date range (default: last 60 days). Write: SELECT ... FROM costs WHERE ...',
      inputSchema: {
        sql: z.string().describe('SQL query (SELECT/WITH only). A "costs" CTE with columns: usage_date, account_id, account_name, region, service, service_family, line_item_type, operation, usage_type, description, resource_id, usage_amount, cost, list_cost, plus tag columns.'),
        dateRange: dateRangeSchema,
        limit: z.number().optional().describe('Max rows (default 100, max 500)'),
      },
    },
    async (params) => {
      try {
        return await runSql(ctx, params);
      } catch (err: unknown) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
