import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GCS_READ_ONLY_SCOPE, createGcsStorage } from '../sync/gcs-storage.js';

/** Both SDKs are replaced wholesale. `Storage` records the options it was
 *  built with; `GoogleAuth` stands in for Application Default Credentials and
 *  hands back whatever `adcClient` is set to; `Impersonated` records its
 *  options and exposes `getTargetPrincipal`, the one accessor the code under
 *  test reads to recognise a legacy ADC file that already impersonates. */
const { storageOptions, googleAuthOptions, impersonatedOptions, state } = vi.hoisted(() => {
  const storage: Record<string, unknown>[] = [];
  const googleAuth: Record<string, unknown>[] = [];
  const impersonated: Record<string, unknown>[] = [];
  const adc: { adcClient: unknown; adcError: Error | undefined } = { adcClient: undefined, adcError: undefined };
  return { storageOptions: storage, googleAuthOptions: googleAuth, impersonatedOptions: impersonated, state: adc };
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

vi.mock('google-auth-library', () => {
  class Impersonated {
    readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      impersonatedOptions.push(options);
    }
    getTargetPrincipal(): unknown {
      return this.options['targetPrincipal'];
    }
  }
  class GoogleAuth {
    constructor(options: Record<string, unknown>) {
      googleAuthOptions.push(options);
    }
    getClient(): Promise<unknown> {
      if (state.adcError !== undefined) return Promise.reject(state.adcError);
      return Promise.resolve(state.adcClient);
    }
  }
  return { GoogleAuth, Impersonated };
});

const READER_A = 'reader-a@personal-proj.iam.gserviceaccount.com';
const READER_B = 'reader-b@company-proj.iam.gserviceaccount.com';
const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The user's own ADC login — the shape `gcloud auth application-default
 *  login` (no impersonation flag) produces. */
const userAdc = { kind: 'authorized_user' };

function onlyStorageOptions(): Record<string, unknown> {
  expect(storageOptions).toHaveLength(1);
  const [options] = storageOptions;
  if (options === undefined) throw new Error('Storage was never constructed');
  return options;
}

beforeEach(() => {
  storageOptions.length = 0;
  googleAuthOptions.length = 0;
  impersonatedOptions.length = 0;
  state.adcClient = userAdc;
  state.adcError = undefined;
});

describe('createGcsStorage without impersonation', () => {
  it('reads Application Default Credentials with the read-only scope and never touches google-auth-library', async () => {
    await createGcsStorage({});
    expect(onlyStorageOptions()).toEqual({ scopes: [GCS_READ_ONLY_SCOPE] });
    expect(googleAuthOptions).toEqual([]);
    expect(impersonatedOptions).toEqual([]);
  });

  it('forwards a key file and a project id unchanged', async () => {
    await createGcsStorage({ keyFile: '/keys/reader.json', projectId: 'billing-proj' });
    expect(onlyStorageOptions()).toEqual({
      scopes: [GCS_READ_ONLY_SCOPE],
      projectId: 'billing-proj',
      keyFilename: '/keys/reader.json',
    });
  });
});

describe('createGcsStorage with impersonateServiceAccount', () => {
  it('impersonates the service account from the user ADC, asking only for read-only storage', async () => {
    await createGcsStorage({ impersonateServiceAccount: READER_A, projectId: 'billing-proj' });

    // The source credential needs cloud-platform to call the IAM Credentials
    // API; the minted token is narrowed to read-only storage.
    expect(googleAuthOptions).toEqual([{ scopes: [IAM_SCOPE] }]);
    expect(impersonatedOptions).toEqual([{
      sourceClient: userAdc,
      targetPrincipal: READER_A,
      targetScopes: [GCS_READ_ONLY_SCOPE],
      lifetime: 3600,
    }]);

    const options = onlyStorageOptions();
    expect(options['projectId']).toBe('billing-proj');
    expect(options['scopes']).toEqual([GCS_READ_ONLY_SCOPE]);
    expect(options).not.toHaveProperty('keyFilename');
    const authClient = options['authClient'];
    expect(authClient).toBeDefined();
    expect(authClient).not.toBe(userAdc);
    expect(authClient).toHaveProperty('options.targetPrincipal', READER_A);
  });

  it('gives two providers sharing one ADC login their own service account each', async () => {
    await createGcsStorage({ impersonateServiceAccount: READER_A });
    await createGcsStorage({ impersonateServiceAccount: READER_B });

    expect(impersonatedOptions.map(o => o['targetPrincipal'])).toEqual([READER_A, READER_B]);
    expect(impersonatedOptions.map(o => o['sourceClient'])).toEqual([userAdc, userAdc]);
    const principals = storageOptions.map(o => {
      const client: unknown = o['authClient'];
      return typeof client === 'object' && client !== null && 'getTargetPrincipal' in client && typeof client.getTargetPrincipal === 'function'
        ? String(client.getTargetPrincipal())
        : null;
    });
    expect(principals).toEqual([READER_A, READER_B]);
  });

  it('reuses a legacy ADC file that already impersonates the same service account', async () => {
    // `gcloud auth application-default login --impersonate-service-account=A`
    // makes ADC itself an Impersonated(A). Wrapping it again would ask A for
    // the right to impersonate A, which nobody grants — so it is used as-is.
    const { Impersonated } = await import('google-auth-library');
    const legacy = new Impersonated({ targetPrincipal: READER_A });
    impersonatedOptions.length = 0;
    state.adcClient = legacy;

    await createGcsStorage({ impersonateServiceAccount: READER_A });

    expect(impersonatedOptions).toEqual([]);
    expect(onlyStorageOptions()['authClient']).toBe(legacy);
  });

  it('chains from a legacy ADC that impersonates a DIFFERENT account rather than silently using it', async () => {
    const { Impersonated } = await import('google-auth-library');
    const legacy = new Impersonated({ targetPrincipal: READER_A });
    impersonatedOptions.length = 0;
    state.adcClient = legacy;

    await createGcsStorage({ impersonateServiceAccount: READER_B });

    expect(impersonatedOptions).toEqual([{
      sourceClient: legacy,
      targetPrincipal: READER_B,
      targetScopes: [GCS_READ_ONLY_SCOPE],
      lifetime: 3600,
    }]);
  });

  it('surfaces a missing ADC login as the SDK error, unchanged', async () => {
    state.adcError = new Error('Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication');
    await expect(createGcsStorage({ impersonateServiceAccount: READER_A }))
      .rejects.toThrow(/Could not load the default credentials/);
    expect(storageOptions).toEqual([]);
  });

  it('refuses a key file combined with impersonation instead of half-applying either', async () => {
    await expect(createGcsStorage({ keyFile: '/keys/reader.json', impersonateServiceAccount: READER_A }))
      .rejects.toThrow(/keyFile and impersonateServiceAccount/);
    expect(storageOptions).toEqual([]);
    expect(googleAuthOptions).toEqual([]);
  });
});
