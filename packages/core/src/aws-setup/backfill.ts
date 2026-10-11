import { isStringRecord } from '../utils/json.js';
import { EXPORTS_STACK_LAYOUT } from './exports-stack.js';

// A new AWS Data Export has no history; AWS re-delivers past months when asked
// through a support case. The case's wording follows AWS's Cloud Intelligence
// Dashboards guide. The text is built here, never taken from the renderer, so
// a case filed through the Support API says only this.

/** The exports a backfill can cover. Cost Optimization Hub recommendations
 *  are daily snapshots: there is no past to re-deliver. */
export type BackfillTier = 'daily' | 'hourly';

/** How far back to ask for. AWS's guide mentions up to 14 months; a year is
 *  what CostGoblin's daily retention keeps by default. */
export const BACKFILL_MONTHS = 12;

export interface BackfillCase {
  readonly subject: string;
  readonly serviceCode: 'billing';
  readonly categoryCode: 'other-billing-questions';
  readonly body: string;
}

/** What filing the case through the Support API answered. */
export type BackfillCaseResult =
  | { readonly status: 'filed'; readonly caseId: string }
  /** The account's support plan has no API access: use the console form. */
  | { readonly status: 'subscription-required' }
  | { readonly status: 'error'; readonly message: string };

export interface BackfillRequest {
  /** The AWS profile to file the case with, in the account owning the exports. */
  readonly profile: string;
  readonly tiers: readonly BackfillTier[];
}

export function backfillCase(tiers: readonly BackfillTier[]): BackfillCase {
  const names = tiers.map(t => EXPORTS_STACK_LAYOUT[t].exportName);
  const named = names.length === 1 ? `Export named ${names.join('')}` : `Exports named ${names.join(' and ')}`;
  return {
    subject: 'Backfill Data',
    serviceCode: 'billing',
    categoryCode: 'other-billing-questions',
    body: `Hello,\n\nPlease backfill the AWS Data ${named} in this account with the last ${String(BACKFILL_MONTHS)} months of billing data.\n\nThank you.`,
  };
}

/** The case as the Support Center form takes it, to copy and paste. */
export function backfillCaseText(supportCase: BackfillCase): string {
  return `Service: Billing\nCategory: Other Billing Questions\nSubject: ${supportCase.subject}\n\n${supportCase.body}`;
}

const REQUEST_KEYS = new Set(['profile', 'tiers']);

/** A filing request from the renderer, checked: it reaches the main process
 *  over IPC and files a case in the user's AWS account. */
export function parseBackfillRequest(payload: unknown): BackfillRequest | null {
  if (!isStringRecord(payload)) return null;
  if (Object.keys(payload).some(k => !REQUEST_KEYS.has(k))) return null;
  const { profile, tiers } = payload;
  // AWS profile names are a single line of printable characters.
  if (typeof profile !== 'string' || !/^[\x21-\x7e]+$/.test(profile)) return null;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const items: readonly unknown[] = tiers;
  const parsed: BackfillTier[] = [];
  for (const tier of items) {
    if ((tier !== 'daily' && tier !== 'hourly') || parsed.includes(tier)) return null;
    parsed.push(tier);
  }
  return { profile, tiers: parsed };
}
