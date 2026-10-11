import { describe, expect, it } from 'vitest';
import { backfillCase, backfillCaseText, parseBackfillRequest } from '../aws-setup/index.js';

describe('backfillCase', () => {
  it('asks Billing for the last year of the daily export', () => {
    expect(backfillCase(['daily'])).toEqual({
      subject: 'Backfill Data',
      serviceCode: 'billing',
      categoryCode: 'other-billing-questions',
      body: 'Hello,\n\nPlease backfill the AWS Data Export named costgoblin-daily in this account with the last 12 months of billing data.\n\nThank you.',
    });
  });

  it('names every FOCUS export it covers', () => {
    expect(backfillCase(['daily', 'hourly']).body)
      .toContain('the AWS Data Exports named costgoblin-daily and costgoblin-hourly in this account');
  });

  it('reads as the console form asks for it', () => {
    expect(backfillCaseText(backfillCase(['daily']))).toBe(
      'Service: Billing\nCategory: Other Billing Questions\nSubject: Backfill Data\n\n'
      + 'Hello,\n\nPlease backfill the AWS Data Export named costgoblin-daily in this account with the last 12 months of billing data.\n\nThank you.',
    );
  });
});

describe('parseBackfillRequest', () => {
  it('accepts a profile and the FOCUS exports to backfill', () => {
    expect(parseBackfillRequest({ profile: 'billing-admin', tiers: ['daily', 'hourly'] }))
      .toEqual({ profile: 'billing-admin', tiers: ['daily', 'hourly'] });
  });

  it.each([
    ['a non-object', 'billing'],
    ['no profile', { tiers: ['daily'] }],
    ['an empty profile', { profile: '', tiers: ['daily'] }],
    ['a profile with a newline', { profile: 'a\nb', tiers: ['daily'] }],
    ['no tiers', { profile: 'p', tiers: [] }],
    ['the Cost Optimization export, which has no history to backfill', { profile: 'p', tiers: ['costOptimization'] }],
    ['a repeated tier', { profile: 'p', tiers: ['daily', 'daily'] }],
    ['an unknown key', { profile: 'p', tiers: ['daily'], body: 'anything' }],
  ])('refuses %s', (_label, payload) => {
    expect(parseBackfillRequest(payload)).toBeNull();
  });
});
