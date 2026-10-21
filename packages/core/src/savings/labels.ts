import type { PreferredCommitment } from '../types/api.js';
import type { CommitmentDetails, CommitmentPaymentOption, CommitmentTerm } from '../types/query.js';

// Commitment terms and payment options: parsed from COH exports and the
// preferences file, and named the same way in the Savings view and the MCP
// tool. No imports beyond types.

export const COMMITMENT_TERMS: readonly CommitmentTerm[] = ['OneYear', 'ThreeYears'];
export const COMMITMENT_PAYMENT_OPTIONS: readonly CommitmentPaymentOption[] = ['NoUpfront', 'PartialUpfront', 'AllUpfront'];

export const COMMITMENT_TERM_LABELS: Readonly<Record<CommitmentTerm, string>> = { OneYear: '1-year', ThreeYears: '3-year' };
export const COMMITMENT_PAYMENT_LABELS: Readonly<Record<CommitmentPaymentOption, string>> = {
  NoUpfront: 'no upfront',
  PartialUpfront: 'partial upfront',
  AllUpfront: 'all upfront',
};

/** Count each pool at its highest-savings option, COH's default. */
export const HIGHEST_SAVINGS: PreferredCommitment = { term: null, paymentOption: null };

export function parseCommitmentTerm(v: unknown): CommitmentTerm | null {
  return v === 'OneYear' || v === 'ThreeYears' ? v : null;
}

export function parseCommitmentPaymentOption(v: unknown): CommitmentPaymentOption | null {
  return v === 'NoUpfront' || v === 'PartialUpfront' || v === 'AllUpfront' ? v : null;
}

/** `3-year, all upfront, Standard`; '' when the export named none of them. */
export function commitmentOptionLabel(details: CommitmentDetails): string {
  return [
    details.term === null ? '' : COMMITMENT_TERM_LABELS[details.term],
    details.paymentOption === null ? '' : COMMITMENT_PAYMENT_LABELS[details.paymentOption],
    details.offeringClass,
  ].filter(p => p.length > 0).join(', ');
}

/** `the highest-savings option`, `1-year, no upfront`, `1-year, highest-savings payment`. */
export function preferredCommitmentLabel(preferred: PreferredCommitment): string {
  if (preferred.term === null && preferred.paymentOption === null) return 'the highest-savings option';
  const term = preferred.term === null ? 'highest-savings term' : COMMITMENT_TERM_LABELS[preferred.term];
  const payment = preferred.paymentOption === null ? 'highest-savings payment' : COMMITMENT_PAYMENT_LABELS[preferred.paymentOption];
  return `${term}, ${payment}`;
}
