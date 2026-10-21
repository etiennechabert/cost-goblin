import type { PreferredCommitment, SavingsPreferences, SavingsPreferencesUpdate } from '../types/api.js';
import type { CommitmentPaymentOption, CommitmentTerm } from '../types/query.js';
import { isStringArray, isStringRecord } from '../utils/json.js';

// savings-preferences.json is read by the app and by the MCP server, and
// written from renderer payloads: both directions go through these parsers,
// so a hand-edited or partial file, or an unexpected save payload, never
// reaches the Savings counts as anything but a known value. No Node imports.

export const SAVINGS_PREFERENCES_DEFAULTS: SavingsPreferences = {
  hiddenActionTypes: [],
  preferredCommitment: { term: null, paymentOption: null },
};

function parseTerm(v: unknown): CommitmentTerm | null {
  return v === 'OneYear' || v === 'ThreeYears' ? v : null;
}

function parsePaymentOption(v: unknown): CommitmentPaymentOption | null {
  return v === 'NoUpfront' || v === 'PartialUpfront' || v === 'AllUpfront' ? v : null;
}

function parsePreferredCommitment(raw: unknown): PreferredCommitment | undefined {
  if (!isStringRecord(raw)) return undefined;
  return { term: parseTerm(raw['term']), paymentOption: parsePaymentOption(raw['paymentOption']) };
}

/** The fields of `raw` that are valid preferences; anything else is dropped.
 *  An unknown term or payment option reads as "highest savings". */
export function parseSavingsPreferencesUpdate(raw: unknown): SavingsPreferencesUpdate {
  if (!isStringRecord(raw)) return {};
  const hidden = raw['hiddenActionTypes'];
  const preferredCommitment = parsePreferredCommitment(raw['preferredCommitment']);
  return {
    ...(isStringArray(hidden) ? { hiddenActionTypes: hidden } : {}),
    ...(preferredCommitment === undefined ? {} : { preferredCommitment }),
  };
}

/** Preferences read from disk: a missing or malformed field gets its default. */
export function parseSavingsPreferences(raw: unknown): SavingsPreferences {
  return { ...SAVINGS_PREFERENCES_DEFAULTS, ...parseSavingsPreferencesUpdate(raw) };
}
