import { tagColumnName } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { markdownTable, type ColumnDef } from '../formatters/markdown-table.js';
import { toolResult } from './tool-helpers.js';

export async function listDimensions(
  ctx: McpContext,
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const dimensions = await ctx.getDimensions();

  const columns: ColumnDef[] = [
    { header: 'ID' },
    { header: 'Label' },
    { header: 'Type' },
    { header: 'Enabled' },
    { header: 'Description' },
  ];

  const rows: string[][] = [];

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
      tagColumnName(dim.tagName),
      dim.label,
      dim.concept !== undefined ? `tag (${dim.concept})` : 'tag',
      dim.enabled === false ? 'no' : 'yes',
      dim.description ?? '',
    ]);
  }

  const table = markdownTable(columns, rows);
  return toolResult(`## Available Dimensions\n\n${table}\n\nUse the \`id\` column value as the \`groupBy\`, \`dimensionId\`, or filter key in other tools.`);
}
