import { describe, expect, it } from 'vitest';
import { DEFAULT_READER_ACCOUNT_ID, resolveReaderInput } from '../config/service-account.js';

describe('resolveReaderInput', () => {
  it('defaults to the account the setup guide creates', () => {
    expect(DEFAULT_READER_ACCOUNT_ID).toBe('costgoblin-reader');
  });

  it('completes a bare account name with the chosen project', () => {
    expect(resolveReaderInput(' costgoblin-reader ', 'gcp-billing-history-hf'))
      .toEqual({ kind: 'address', address: 'costgoblin-reader@gcp-billing-history-hf.iam.gserviceaccount.com' });
  });

  it('keeps a full address as typed, for a reader that lives in another project', () => {
    expect(resolveReaderInput('reader@other-proj.iam.gserviceaccount.com', 'gcp-billing-history-hf'))
      .toEqual({ kind: 'address', address: 'reader@other-proj.iam.gserviceaccount.com' });
  });

  it('reads as yourself when blank', () => {
    expect(resolveReaderInput('   ', 'gcp-billing-history-hf')).toEqual({ kind: 'none' });
  });

  it('waits for a project before completing a bare name', () => {
    expect(resolveReaderInput('costgoblin-reader', undefined)).toEqual({ kind: 'needs-project', accountId: 'costgoblin-reader' });
  });

  it('rejects anything that is neither an account name nor a service-account address', () => {
    for (const bad of ['me@gmail.com', 'cg', 'Costgoblin-Reader', 'costgoblin_reader', 'reader-', '--impersonate=x']) {
      expect(resolveReaderInput(bad, 'proj-123'), bad).toEqual({ kind: 'invalid' });
    }
  });
});
