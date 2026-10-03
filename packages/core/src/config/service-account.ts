/** The documented service-account address grammar:
 *  `<6-30 chars, starting with a letter>@<project>.iam.gserviceaccount.com`.
 *
 *  A leaf module so the renderer can import it through `@costgoblin/core/browser`
 *  without pulling in the config loader. An impersonation target lands in a
 *  gcloud argv (`--impersonate-service-account=<value>`) and can arrive from a
 *  shared config bundle, so the loader, the wizard's config writer and the
 *  wizard's input all check it against this one pattern. */
const SERVICE_ACCOUNT_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

export function isServiceAccountEmail(value: string): boolean {
  return SERVICE_ACCOUNT_EMAIL.test(value);
}

export const SERVICE_ACCOUNT_EMAIL_HINT = 'a service-account address like name@project.iam.gserviceaccount.com';
