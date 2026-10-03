import type { GcloudLoginMode } from '@costgoblin/core';

/** argv for the sign-in button. ADC is always the user's OWN login — never
 *  `--impersonate-service-account`: each provider's `impersonateServiceAccount`
 *  is applied per client on top of ADC (`createGcsStorage`), so ADC must stay
 *  the plain credential every reader is minted from. */
export function gcloudLoginArgs(mode: GcloudLoginMode): string[] {
  return mode === 'cli' ? ['auth', 'login'] : ['auth', 'application-default', 'login'];
}

/** The child env for the sign-in. Without a flag, `application-default login`
 *  still impersonates whatever `auth/impersonate_service_account` is set to
 *  (gcloud resolves it flag > env > config file), so the ADC login blanks it:
 *  an empty env value counts as set and wins over the config file. */
export function gcloudLoginEnv(mode: GcloudLoginMode, baseEnv: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    PATH: path,
    ...(mode === 'adc' ? { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '' } : {}),
  };
}
