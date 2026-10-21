import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  commitmentOptionLabel,
  countSavings,
  loadSavingsRecommendations,
  parseJsonObject,
  parseSavingsPreferences,
  preferredCommitmentLabel,
  SAVINGS_PREFERENCES_DEFAULTS,
} from '@costgoblin/core';
import type { SavingsGroup, SavingsPreferences } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import type { Cell, Column, MetaField, StructuredResult } from '../formatters/result.js';
import { resolveFormat, structuredToolResult, toolResult } from './tool-helpers.js';

// list_savings_recommendations answers with what the app's Savings view
// counts: each provider's latest Cost Optimization Hub snapshot, one action
// per resource and one option per commitment pool, commitments shrunk by the
// spend the counted resource actions remove — at the commitment term and with
// the action types hidden that the user picked in the view. COH recommendations
// are not billing data, so no freshness lag or cost scope applies to them.

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

const COLUMNS: readonly Column[] = [
  { key: 'action', header: 'Action' },
  { key: 'target', header: 'Resource or commitment' },
  { key: 'option', header: 'Option' },
  { key: 'account', header: 'Account' },
  { key: 'accountId', header: 'Account ID' },
  { key: 'region', header: 'Region' },
  { key: 'savingsPerMonth', header: 'Savings/mo', type: 'currency' },
  { key: 'cohEstimatePerMonth', header: 'COH estimate/mo', type: 'currency' },
  { key: 'effort', header: 'Effort' },
  { key: 'alternatives', header: 'Alternatives not counted', type: 'number' },
];

async function readPreferences(stateDir: string): Promise<SavingsPreferences> {
  try {
    return parseSavingsPreferences(parseJsonObject(await readFile(join(stateDir, 'savings-preferences.json'), 'utf-8')));
  } catch {
    return SAVINGS_PREFERENCES_DEFAULTS; // never saved
  }
}

function row(group: SavingsGroup): Cell[] {
  const rec = group.counted;
  return [
    rec.actionType,
    rec.commitment === null ? rec.resourceArn : rec.commitment.poolLabel,
    rec.commitment === null ? '' : commitmentOptionLabel(rec.commitment),
    rec.accountName,
    rec.accountId,
    rec.region,
    group.monthlySavings,
    rec.monthlySavings,
    rec.effort,
    group.alternatives.length,
  ];
}

export async function listSavingsRecommendations(
  ctx: McpContext,
  params: { actionType?: string | undefined; limit?: number | undefined; format?: string | undefined },
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const config = await ctx.getConfig();
  const { recommendations, snapshots } = await loadSavingsRecommendations(ctx.dataDir, config.providers, ctx.runQuery);
  if (recommendations.length === 0) {
    return toolResult('No Cost Optimization Hub recommendations are synced. AWS providers sync them from a Cost Optimization Hub data export: ask the user to set up and sync the cost optimization tier in the app\'s Data tab.');
  }

  const prefs = await readPreferences(ctx.stateDir);
  const hidden = new Set(prefs.hiddenActionTypes);
  const visible = recommendations.filter(r => !hidden.has(r.actionType));
  const counted = countSavings(visible, prefs.preferredCommitment);
  const groups = params.actionType === undefined
    ? counted.groups
    : counted.groups.filter(g => g.counted.actionType === params.actionType);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT)));
  const shown = groups.slice(0, limit);

  const meta: MetaField[] = [
    { label: 'Counted savings/mo', value: groups.reduce((sum, g) => sum + g.monthlySavings, 0), type: 'currency' },
    { label: 'Actions', value: groups.length, type: 'number' },
    { label: 'Alternatives not counted', value: visible.length - counted.groups.length, type: 'number' },
    { label: 'Commitments counted at', value: preferredCommitmentLabel(prefs.preferredCommitment) },
    { label: 'Snapshot', value: snapshots.map(s => `${s.providerName} ${s.date}`).join(', ') },
    { label: 'Hidden in the Savings view', value: prefs.hiddenActionTypes.length > 0 ? prefs.hiddenActionTypes.join(', ') : 'none' },
  ];
  const notes = [
    'Counts one action per resource (the highest savings) and one option per commitment pool, as Cost Optimization Hub\'s dashboard does: '
      + 'other terms, and the EC2 Instance Savings Plans and EC2 Reserved Instances a Compute Savings Plan covers, are alternatives, not extra savings. '
      + 'A commitment is scaled down by the eligible spend the counted resource actions remove; "COH estimate/mo" is its unscaled figure.',
  ];
  if (shown.length < groups.length) notes.push(`Showing ${String(shown.length)} of ${String(groups.length)} actions, highest savings first; pass a larger limit to see more.`);

  const result: StructuredResult = {
    title: `Cost optimization recommendations (${String(groups.length)})${params.actionType === undefined ? '' : ` — ${params.actionType}`}`,
    meta,
    notes,
    tables: [{ columns: COLUMNS, rows: shown.map(row) }],
  };
  return structuredToolResult(result, resolveFormat(params.format));
}
