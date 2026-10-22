import type { PreferredCommitment, SavingsPreferences, SavingsPreferencesUpdate } from '../types/api.js';
import { isStringArray, isStringRecord } from '../utils/json.js';
import { HIGHEST_SAVINGS, parseCommitmentPaymentOption, parseCommitmentTerm } from './labels.js';

// savings-preferences.json is read by the app and by the MCP server, and
// written from renderer payloads: both directions go through these parsers,
// so a hand-edited or partial file, or an unexpected save payload, never
// reaches the Savings counts as anything but a known value. No Node imports.

export const SAVINGS_PREFERENCES_DEFAULTS: SavingsPreferences = {
  hiddenActionTypes: [],
  preferredCommitment: HIGHEST_SAVINGS,
};

function parsePreferredCommitment(raw: unknown): PreferredCommitment | undefined {
  if (!isStringRecord(raw)) return undefined;
  return { term: parseCommitmentTerm(raw['term']), paymentOption: parseCommitmentPaymentOption(raw['paymentOption']) };
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
