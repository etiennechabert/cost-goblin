import {
  adcCredentialsLocation,
  adcLoginImpersonationToKeep,
  isPathPlaceholder,
  parseJsonObject,
} from '@costgoblin/core';
import type { GcloudLoginMode, GcpProviderCredentialOptions } from '@costgoblin/core';

/** argv for the sign-in button. ADC is the user's OWN login: each provider's
 *  `impersonateServiceAccount` is applied per client on top of it
 *  (`createGcsStorage`), so ADC stays the plain credential every reader is
 *  minted from — with one exception, `keepImpersonation`: while a provider
 *  without a reader still lists through a legacy impersonated ADC, signing in
 *  again re-creates that impersonation rather than silently widening the
 *  provider to the user's own access (`adcLoginImpersonationToKeep`). */
export function gcloudLoginArgs(mode: GcloudLoginMode, keepImpersonation: string | null): string[] {
  if (mode === 'cli') return ['auth', 'login'];
  const login = ['auth', 'application-default', 'login'];
  return keepImpersonation === null ? login : [...login, `--impersonate-service-account=${keepImpersonation}`];
}

/** The child env for the sign-in. Without a flag, `application-default login`
 *  still impersonates whatever `auth/impersonate_service_account` is set to
 *  (gcloud resolves it flag > env > config file), so a plain ADC login blanks
 *  it: an empty env value counts as set and wins over the config file. When
 *  an impersonation is kept, its explicit flag wins on its own. */
export function gcloudLoginEnv(
  mode: GcloudLoginMode,
  baseEnv: NodeJS.ProcessEnv,
  path: string,
  keepImpersonation: string | null,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PATH: path,
    ...(mode === 'adc' && keepImpersonation === null ? { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '' } : {}),
  };
}

export interface AdcLoginDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string) => Promise<string>;
}

/** The impersonation an ADC sign-in must keep, read from the file the Cloud
 *  Storage SDK reads (`GOOGLE_APPLICATION_CREDENTIALS`, else gcloud's
 *  well-known file — the panel's location logic). Null — a plain sign-in —
 *  when there is no such file, it cannot be read, or nothing depends on it. */
export async function adcImpersonationToKeep(
  deps: AdcLoginDeps,
  providers: readonly GcpProviderCredentialOptions[],
): Promise<string | null> {
  const location = adcCredentialsLocation(deps.env, deps.platform);
  if (location === null || isPathPlaceholder(location.path)) return null;
  let text: string;
  try {
    text = await deps.readFile(location.path);
  } catch {
    return null;
  }
  return adcLoginImpersonationToKeep(parseJsonObject(text), providers);
}
