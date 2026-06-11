import { tagDimColumn } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, StructuredResult } from '../formatters/result.js';
import { computeDataCoverage, resolveFormat, structuredToolResult } from './tool-helpers.js';

export async function listDimensions(
  ctx: McpContext,
  params: { format?: string | undefined } = {},
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const format = resolveFormat(params.format);
  const dimensions = await ctx.getDimensions();

  const columns: Column[] = [
    { key: 'id', header: 'ID' },
    { key: 'label', header: 'Label' },
    { key: 'type', header: 'Type' },
    { key: 'enabled', header: 'Enabled' },
    { key: 'description', header: 'Description' },
  ];

  const rows: Cell[][] = [];
  for (const dim of dimensions.builtIn) {
    rows.push([
      dim.name,
      dim.label,
      'built-in',
      dim.enabled === false ? 'no' : 'yes',
      dim.description ?? '',
    ]);
  }
  for (const dim of dimensions.tags) {
    rows.push([
      tagDimColumn(dim),
      dim.label,
      dim.concept !== undefined ? `tag (${dim.concept})` : 'tag',
      dim.enabled === false ? 'no' : 'yes',
      dim.description ?? '',
    ]);
  }

  const coverage = await computeDataCoverage(ctx);
  const result: StructuredResult = {
    title: 'Available Dimensions',
    coverage,
    tables: [{ columns, rows }],
    notes: ['Use the `id` column value as the `groupBy`, `dimensionId`, or filter key in other tools.'],
  };
  return structuredToolResult(result, format);
}
