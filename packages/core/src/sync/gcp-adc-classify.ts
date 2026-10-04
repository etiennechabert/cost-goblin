import { isStringRecord } from '../utils/json.js';

/** The one reading of an `impersonated_service_account` credential file — the
 *  shape `gcloud auth application-default login --impersonate-service-account`
 *  writes. Shared by the code that USES the file (`createGcsStorage`, which
 *  unwraps it to the login underneath when a provider names its own reader)
 *  and the code that DESCRIBES it (the "Signed in as" panel), so the panel can
 *  never call a file working that the listing client would reject, or the
 *  reverse. Mirrors google-auth-library 9's `fromImpersonatedJSON`. */

/** google-auth-library refuses longer impersonation URLs (a ReDoS guard); a
 *  URL it would reject must not be described as working here. */
const MAX_IMPERSONATION_URL_LENGTH = 256;

const IMPERSONATION_VERBS: readonly string[] = ['generateAccessToken', 'generateIdToken'];

/** The target service account of an IAM Credentials impersonation URL — the
 *  same extraction `GoogleAuth.fromImpersonatedJSON` performs, with its exact
 *  pattern: anything stricter would make the listing client refuse a file the
 *  SDK loads. */
export function impersonationTargetFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > MAX_IMPERSONATION_URL_LENGTH) return null;
  // `/([^/]+):(?:generateAccessToken|generateIdToken)$/` without a regex:
  // the last path segment, minus a trailing `:<verb>`, when anything is left.
  const segment = url.slice(url.lastIndexOf('/') + 1);
  for (const verb of IMPERSONATION_VERBS) {
    const suffix = `:${verb}`;
    if (segment.length > suffix.length && segment.endsWith(suffix)) return segment.slice(0, -suffix.length);
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The credential an impersonated file mints its target FROM. */
export type ImpersonatedAdcSource =
  /** A user's own login: the record holds the refresh token. */
  | { readonly kind: 'user'; readonly record: Readonly<Record<string, unknown>> }
  /** A service-account key (the SDK's JWT path). */
  | { readonly kind: 'service-account'; readonly email: string; readonly record: Readonly<Record<string, unknown>> }
  /** A credential the SDK accepts as a source but CostGoblin cannot unwrap
   *  to mint a provider's reader from (federation, a nested impersonation).
   *  gcloud never writes these. */
  | { readonly kind: 'other'; readonly type: string };

export type ImpersonatedAdc =
  /** Not an `impersonated_service_account` file at all. */
  | { readonly kind: 'not-impersonated' }
  /** An `impersonated_service_account` file the SDK rejects: no usable
   *  impersonation URL, or a `source_credentials` it cannot build a client
   *  from. */
  | { readonly kind: 'unusable' }
  | {
    readonly kind: 'impersonated';
    readonly target: string;
    /** The file's `delegates`: the hops of a delegation chain before
     *  `target`, in order. */
    readonly delegates: readonly string[];
    readonly source: ImpersonatedAdcSource;
  };

/** Source types the SDK hands to a dedicated client rather than the JWT path. */
const NON_JWT_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'impersonated_service_account',
  'external_account',
  'external_account_authorized_user',
]);

/** What `GoogleAuth.fromJSON` makes of a source: a user login needs all three
 *  refresh fields (`UserRefreshClient.fromJSON` throws otherwise), anything
 *  that is not a dedicated type goes down the JWT path, which needs
 *  `client_email` and `private_key`. Null: the SDK would throw. */
function classifySource(raw: unknown): ImpersonatedAdcSource | null {
  if (!isStringRecord(raw)) return null;
  const type = nonEmptyString(raw['type']);
  if (type === 'authorized_user') {
    const complete = ['client_id', 'client_secret', 'refresh_token'].every(key => nonEmptyString(raw[key]) !== null);
    return complete ? { kind: 'user', record: raw } : null;
  }
  if (type !== null && NON_JWT_SOURCE_TYPES.has(type)) return { kind: 'other', type };
  const email = nonEmptyString(raw['client_email']);
  if (email === null || nonEmptyString(raw['private_key']) === null) return null;
  return { kind: 'service-account', email, record: raw };
}

/** Classify a parsed credential file as the SDK would load it. */
export function classifyImpersonatedAdc(content: unknown): ImpersonatedAdc {
  if (!isStringRecord(content) || content['type'] !== 'impersonated_service_account') return { kind: 'not-impersonated' };
  const target = impersonationTargetFromUrl(content['service_account_impersonation_url']);
  const source = classifySource(content['source_credentials']);
  if (target === null || source === null) return { kind: 'unusable' };
  const rawDelegates = content['delegates'];
  const delegates = Array.isArray(rawDelegates)
    ? rawDelegates.filter((d): d is string => typeof d === 'string' && d.length > 0)
    : [];
  return { kind: 'impersonated', target, delegates, source };
}

/** The provider fields that decide how a provider lists. */
export interface GcpProviderCredentialOptions {
  readonly keyFile?: string | undefined;
  readonly impersonateServiceAccount?: string | undefined;
}

/** The impersonation the app's ADC Sign in button must keep, as the
 *  `--impersonate-service-account` value — or null for a plain sign-in.
 *
 *  A provider with neither a reader nor a key file lists through ADC as it
 *  is. When ADC is a legacy impersonated file, that provider reads as the
 *  file's service account; a plain sign-in would silently widen it to the
 *  user's own access. So while any such provider exists, signing in again
 *  re-creates the same impersonation (delegation chain included). Once every
 *  provider names its reader, the plain sign-in is safe. Only well-formed
 *  service-account addresses are passed on: the value becomes an argv
 *  entry. */
export function adcLoginImpersonationToKeep(
  adcContent: unknown,
  providers: readonly GcpProviderCredentialOptions[],
): string | null {
  const legacy = classifyImpersonatedAdc(adcContent);
  if (legacy.kind !== 'impersonated') return null;
  if (!providers.some(p => p.impersonateServiceAccount === undefined && p.keyFile === undefined)) return null;
  const chain = [...legacy.delegates, legacy.target];
  return chain.every(isArgvSafeServiceAccount) ? chain.join(',') : null;
}

/** Any Google service-account address — user-created (`*.iam`) or
 *  Google-managed (`*-compute@developer`, `*@appspot`) — and nothing an argv
 *  entry or a Windows shell could misread. Looser than `isServiceAccountEmail`
 *  (the reader a provider may NAME) on purpose: refusing a managed account
 *  here would fall back to a plain sign-in and widen the provider. */
function isArgvSafeServiceAccount(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9.-]*\.gserviceaccount\.com$/.test(value);
}
