import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GCS_READ_ONLY_SCOPE, createGcsStorage } from '../sync/gcs-storage.js';

/** Two corners of minting a provider's reader that `gcs-storage.test.ts`
 *  does not reach: ADC that is already an impersonation of SOMEONE ELSE, and
 *  a reader address with no project in it (a Google-managed service account).
 *  Both SDKs are faked: `GoogleAuth.getClient` hands back `state.adcClient`,
 *  and `Impersonated` records what it was built with. */

const { state, storageOptions, googleAuthOptions, impersonatedOptions, FakeImpersonated } = vi.hoisted(() => {
  const adc: { adcClient: unknown } = { adcClient: undefined };
  const storage: Record<string, unknown>[] = [];
  const googleAuth: Record<string, unknown>[] = [];
  const impersonated: Record<string, unknown>[] = [];
  class Impersonated {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      impersonated.push(options);
    }
    getTargetPrincipal(): string {
      const target = this.options['targetPrincipal'];
      return typeof target === 'string' ? target : '';
    }
  }
  return {
    state: adc,
    storageOptions: storage,
    googleAuthOptions: googleAuth,
    impersonatedOptions: impersonated,
    FakeImpersonated: Impersonated,
  };
});

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      storageOptions.push(options);
    }
  },
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    // A plain login, not a legacy impersonated file: used as it is.
    readonly jsonContent: unknown = null;
    constructor(options: Record<string, unknown>) {
      googleAuthOptions.push(options);
    }
    getClient(): Promise<unknown> {
      return Promise.resolve(state.adcClient);
    }
  },
  Impersonated: FakeImpersonated,
  // Never instantiated here: present so the "already the reader?" checks
  // have their key and federation types to test against.
  JWT: class {
    readonly email: string | undefined = undefined;
  },
  BaseExternalAccountClient: class {
    getServiceAccountEmail(): string | null {
      return null;
    }
  },
}));

const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const READER = 'reader@billing-proj.iam.gserviceaccount.com';
const MANAGED_READER = '123456789012-compute@developer.gserviceaccount.com';

function onlyStorageAuthClient(): unknown {
  expect(storageOptions).toHaveLength(1);
  const [options] = storageOptions;
  if (options === undefined) throw new Error('Storage was never constructed');
  return options['authClient'];
}

beforeEach(() => {
  state.adcClient = { kind: 'authorized_user' };
  storageOptions.length = 0;
  googleAuthOptions.length = 0;
  impersonatedOptions.length = 0;
});

describe('createGcsStorage minting a reader', () => {
  it('mints the reader from an ADC impersonation of a different account instead of using it as is', async () => {
    const other = new FakeImpersonated({ targetPrincipal: 'deployer@billing-proj.iam.gserviceaccount.com' });
    state.adcClient = other;

    await createGcsStorage({ impersonateServiceAccount: READER });

    const authClient = onlyStorageAuthClient();
    expect(authClient).not.toBe(other);
    expect(authClient).toBeInstanceOf(FakeImpersonated);
    expect(impersonatedOptions.at(-1)).toEqual({
      sourceClient: other,
      targetPrincipal: READER,
      targetScopes: [GCS_READ_ONLY_SCOPE],
    });
  });

  it('skips the project hint for a reader address that carries no project', async () => {
    await createGcsStorage({ impersonateServiceAccount: MANAGED_READER });

    // No `projectId` guess: the address has no `<project>.iam` part to read.
    expect(googleAuthOptions).toEqual([{ scopes: [IAM_SCOPE] }]);
    expect(storageOptions[0]).not.toHaveProperty('projectId');
    expect(impersonatedOptions).toEqual([{
      sourceClient: { kind: 'authorized_user' },
      targetPrincipal: MANAGED_READER,
      targetScopes: [GCS_READ_ONLY_SCOPE],
    }]);
  });
});
