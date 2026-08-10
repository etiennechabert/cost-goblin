import type { BaselineTriageStatus } from '@costgoblin/core/browser';

/** Display names for triage statuses — shared by the baselines table and the
 *  detail modal so a renamed status can't show two spellings. */
export const TRIAGE_LABEL: Readonly<Record<BaselineTriageStatus, string>> = {
  'new': 'New', 'tracking': 'Tracking', 'acting': 'Acting',
  'resolved': 'Resolved', 'dismissed': 'Dismissed', 'ignored': 'Ignored',
};

export type TriageTone = 'accent' | 'warning' | 'positive' | 'neutral';

/** Single source of truth for the status palette — chip, dot, and active
 *  styles all derive from a status's tone, so the colors can't drift apart.
 *  (They had: the modal once rendered dismissed/ignored `text-text-muted`
 *  while the table rendered them `text-text-secondary`.) */
export const TRIAGE_TONE: Readonly<Record<BaselineTriageStatus, TriageTone>> = {
  'new': 'neutral', tracking: 'accent', acting: 'warning', resolved: 'positive', dismissed: 'neutral', ignored: 'neutral',
};

const TONE_CHIP: Readonly<Record<TriageTone, string>> = {
  accent: 'text-accent bg-accent/10 border-accent/30',
  warning: 'text-warning bg-warning/10 border-warning/30',
  positive: 'text-positive bg-positive/10 border-positive/30',
  neutral: 'text-text-secondary bg-bg-tertiary/30 border-border',
};

/** Border/background/text classes for a status chip. */
export function triageChipClass(status: BaselineTriageStatus): string {
  return TONE_CHIP[TRIAGE_TONE[status]];
}
