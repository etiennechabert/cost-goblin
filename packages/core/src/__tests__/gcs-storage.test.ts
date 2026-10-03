import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GCS_READ_ONLY_SCOPE, createGcsStorage } from '../sync/gcs-storage.js';

/** Both SDKs are replaced wholesale. `Storage` records the options it was
 *  built with. `GoogleAuth` records its options and stands in for Application
 *  Default Credentials: `getClient` hands back `state.adcClient`, `jsonContent`
 *  is the parsed ADC file, and `fromJSON` builds a tagged client from a
 *  credential body. `Impersonated` records its options. */
const { storageOptions, googleAuthOptions, impersonatedOptions, fromJsonInputs, state } = vi.hoisted(() => {
  const storage: Record<string, unknown>[] = [];
  const googleAuth: Record<string, unknown>[] = [];
  const impersonated: Record<string, unknown>[] = [];
  const fromJson: unknown[] = [];
  const adc: { adcClient: unknown; adcError: Error | undefined; adcFile: unknown } = {
    adcClient: undefined,
    adcError: undefined,
    adcFile: null,
  };
  return { storageOptions: storage, googleAuthOptions: googleAuth, impersonatedOptions: impersonated, fromJsonInputs: fromJson, state: adc };
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
  }
  class GoogleAuth {
    readonly options: Record<string, unknown>;
    readonly jsonContent: unknown = state.adcFile;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      googleAuthOptions.push(options);
    }
    getClient(): Promise<unknown> {
      if (state.adcError !== undefined) return Promise.reject(state.adcError);
      return Promise.resolve(state.adcClient);
    }
    fromJSON(input: unknown): unknown {
      fromJsonInputs.push(input);
      return { kind: 'from-json', input };
    }
  }
  return { GoogleAuth, Impersonated };
});

const READER_A = 'reader-a@personal-proj.iam.gserviceaccount.com';
const READER_B = 'reader-b@company-proj.iam.gserviceaccount.com';
const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The user's own ADC login — what `gcloud auth application-default login`
 *  (no impersonation flag) produces. */
const userAdc = { kind: 'authorized_user' };

/** An ADC file from the legacy `--impersonate-service-account` recipe. */
function legacyAdcFile(target: string): Record<string, unknown> {
  return {
    type: 'impersonated_service_account',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${target}:generateAccessToken`,
    source_credentials: { type: 'authorized_user', client_id: 'cid', client_secret: 'secret', refresh_token: 'rt', ignored: 42 },
  };
}

function onlyStorageOptions(): Record<string, unknown> {
  expect(storageOptions).toHaveLength(1);
  const [options] = storageOptions;
  if (options === undefined) throw new Error('Storage was never constructed');
  return options;
}

function authClientOf(options: Record<string, unknown>): Record<string, unknown> {
  const client: unknown = options['authClient'];
  if (typeof client !== 'object' || client === null || !('options' in client)) throw new Error('no recorded authClient');
  const recorded: unknown = client.options;
  if (typeof recorded !== 'object' || recorded === null) throw new Error('authClient options missing');
  return Object.fromEntries(Object.entries(recorded));
}

beforeEach(() => {
  storageOptions.length = 0;
  googleAuthOptions.length = 0;
  impersonatedOptions.length = 0;
  fromJsonInputs.length = 0;
  state.adcClient = userAdc;
  state.adcError = undefined;
  state.adcFile = null;
});

describe('createGcsStorage without impersonation', () => {
  it('puts the read-only scope on the credential, since Storage ignores its own scopes option', async () => {
    await createGcsStorage({});
    expect(authClientOf(onlyStorageOptions())).toEqual({ scopes: [GCS_READ_ONLY_SCOPE] });
    expect(impersonatedOptions).toEqual([]);
  });

  it('mints a key file read-only and forwards the project id to both Storage and the credential', async () => {
    await createGcsStorage({ keyFile: '/keys/reader.json', projectId: 'billing-proj' });
    const options = onlyStorageOptions();
    expect(options['projectId']).toBe('billing-proj');
    expect(authClientOf(options)).toEqual({ projectId: 'billing-proj', scopes: [GCS_READ_ONLY_SCOPE], keyFilename: '/keys/reader.json' });
  });
});

describe('createGcsStorage with impersonateServiceAccount', () => {
  it('impersonates the service account from the user ADC, asking only for read-only storage', async () => {
    await createGcsStorage({ impersonateServiceAccount: READER_A });

    // The source credential needs cloud-platform to call the IAM Credentials
    // API; its project comes from the reader's address, which spares
    // google-auth-library a gcloud exec + metadata probe per client.
    expect(googleAuthOptions).toEqual([{ scopes: [IAM_SCOPE], projectId: 'personal-proj' }]);
    expect(impersonatedOptions).toEqual([{ sourceClient: userAdc, targetPrincipal: READER_A, targetScopes: [GCS_READ_ONLY_SCOPE] }]);
    const options = onlyStorageOptions();
    expect(options).not.toHaveProperty('projectId');
    expect(authClientOf(options)['targetPrincipal']).toBe(READER_A);
  });

  it('prefers the caller project id over the one in the reader address', async () => {
    await createGcsStorage({ impersonateServiceAccount: READER_A, projectId: 'billing-proj' });
    expect(googleAuthOptions).toEqual([{ scopes: [IAM_SCOPE], projectId: 'billing-proj' }]);
    expect(onlyStorageOptions()['projectId']).toBe('billing-proj');
  });

  it('gives two providers sharing one ADC login their own service account each', async () => {
    await createGcsStorage({ impersonateServiceAccount: READER_A });
    await createGcsStorage({ impersonateServiceAccount: READER_B });

    expect(impersonatedOptions.map(o => o['targetPrincipal'])).toEqual([READER_A, READER_B]);
    expect(impersonatedOptions.map(o => o['sourceClient'])).toEqual([userAdc, userAdc]);
    expect(storageOptions.map(o => authClientOf(o)['targetPrincipal'])).toEqual([READER_A, READER_B]);
  });

  it.each([
    ['the same account', READER_A],
    ['a different account', READER_B],
  ])('mints from the user login underneath a legacy ADC that impersonates %s', async (_label, legacyTarget) => {
    // `application-default login --impersonate-service-account=<x>` makes ADC
    // itself an impersonation. Minting from that wrapper would ask <x> for the
    // right to impersonate the reader; the user's login holds that grant.
    state.adcFile = legacyAdcFile(legacyTarget);
    state.adcClient = { kind: 'legacy-impersonated' };

    await createGcsStorage({ impersonateServiceAccount: READER_A });

    expect(fromJsonInputs).toEqual([{ type: 'authorized_user', client_id: 'cid', client_secret: 'secret', refresh_token: 'rt' }]);
    expect(impersonatedOptions).toHaveLength(1);
    expect(impersonatedOptions[0]?.['sourceClient']).toEqual({ kind: 'from-json', input: fromJsonInputs[0] });
    expect(impersonatedOptions[0]?.['targetPrincipal']).toBe(READER_A);
  });

  it('applies GOOGLE_CLOUD_QUOTA_PROJECT to the unwrapped login, as GoogleAuth does for ADC it loads itself', async () => {
    state.adcFile = legacyAdcFile(READER_A);
    vi.stubEnv('GOOGLE_CLOUD_QUOTA_PROJECT', 'billing-quota');
    try {
      await createGcsStorage({ impersonateServiceAccount: READER_A });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(impersonatedOptions[0]?.['sourceClient']).toMatchObject({ quotaProjectId: 'billing-quota' });
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
