import { describe, expect, it } from 'vitest';
import { resolveReaderInput } from '../config/service-account.js';

describe('resolveReaderInput: completing a bare account name with the chosen project', () => {
  it.each([
    ['uppercase and an underscore', 'Billing_Prod'],
    ['a dot', 'proj.123'],
    ['an @', 'proj@evil'],
    ['a space', 'my project'],
    ['a domain of its own', 'evil.iam.gserviceaccount.com'],
  ])('rejects a project id with %s, which cannot form a service-account address', (_label, projectId) => {
    expect(resolveReaderInput('costgoblin-reader', projectId)).toStrictEqual({ kind: 'invalid' });
  });

  it('waits for a project while the chosen project id is empty', () => {
    expect(resolveReaderInput('costgoblin-reader', '')).toStrictEqual({ kind: 'needs-project', accountId: 'costgoblin-reader' });
  });

  it('completes the name with a well-formed project id', () => {
    expect(resolveReaderInput('costgoblin-reader', 'billing-504501'))
      .toStrictEqual({ kind: 'address', address: 'costgoblin-reader@billing-504501.iam.gserviceaccount.com' });
  });
});
