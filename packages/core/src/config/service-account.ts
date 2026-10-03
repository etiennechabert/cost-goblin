/** The documented service-account address grammar:
 *  `<6-30 chars, starting with a letter>@<project>.iam.gserviceaccount.com`.
 *
 *  A leaf module so the renderer can import it through `@costgoblin/core/browser`
 *  without pulling in the config loader. An impersonation target lands in a
 *  gcloud argv (`--impersonate-service-account=<value>`) and can arrive from a
 *  shared config bundle, so the loader, the wizard's config writer and the
 *  wizard's input all check it against this one pattern. */
const SERVICE_ACCOUNT_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

/** Takes `unknown` because the writer's caller is an IPC payload: `RegExp.test`
 *  stringifies its argument, so without the type check a one-element array
 *  holding a valid address would pass and be written to YAML as a list. */
export function isServiceAccountEmail(value: unknown): value is string {
  return typeof value === 'string' && SERVICE_ACCOUNT_EMAIL.test(value);
}

/** A real, valid address — the hint and the wizard's placeholder show it, so it
 *  must itself pass the grammar (`name@…` would not: the id needs 6+ chars).
 *  Short enough to fit the wizard's input without truncating. */
export const SERVICE_ACCOUNT_EMAIL_EXAMPLE = 'reader@my-project.iam.gserviceaccount.com';

export const SERVICE_ACCOUNT_EMAIL_HINT = `a service-account address like ${SERVICE_ACCOUNT_EMAIL_EXAMPLE}`;
