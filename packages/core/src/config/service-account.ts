/** The address grammar of a GCP service account: a 6–30 character account id
 *  (lowercase letter first, lowercase alphanumerics and hyphens, no trailing
 *  hyphen) at `<project>.iam.gserviceaccount.com`.
 *
 *  Leaf module with no imports, so the setup wizard can check the field it
 *  collects with the exact rule the config validator applies — and so the
 *  main process can re-check a value arriving over IPC before it reaches a
 *  gcloud argv array or an impersonation request. */
const SERVICE_ACCOUNT_EMAIL_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

/** The rule, in words — one copy for the validator, the IPC check and the
 *  wizard, so widening the pattern cannot leave stale messages behind. */
export const SERVICE_ACCOUNT_EMAIL_RULE = 'a service-account address like name@project.iam.gserviceaccount.com';

export function isServiceAccountEmail(value: string): boolean {
  return SERVICE_ACCOUNT_EMAIL_PATTERN.test(value);
}

/** The account name the setup guide's least-privilege recipe creates
 *  (`gcloud iam service-accounts create costgoblin-reader`) — the wizard's
 *  default reader, completed with the project the user picks. */
export const DEFAULT_READER_ACCOUNT_ID = 'costgoblin-reader';

/** The account-id half of the address grammar, on its own. */
const SERVICE_ACCOUNT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export type ReaderInput =
  /** Blank: read as the user's own sign-in. */
  | { readonly kind: 'none' }
  | { readonly kind: 'address'; readonly address: string }
  /** A bare account name, completed once a project is chosen. */
  | { readonly kind: 'needs-project'; readonly accountId: string }
  | { readonly kind: 'invalid' };

/** What the wizard's reader field means: a full service-account address as
 *  typed, or a bare account name completed with `projectId`
 *  (`<name>@<project>.iam.gserviceaccount.com`). The project is the one the
 *  user picks — it cannot be guessed — so a bare name before then is
 *  `needs-project`. */
export function resolveReaderInput(input: string, projectId: string | undefined): ReaderInput {
  const value = input.trim();
  if (value.length === 0) return { kind: 'none' };
  if (isServiceAccountEmail(value)) return { kind: 'address', address: value };
  if (!SERVICE_ACCOUNT_ID_PATTERN.test(value)) return { kind: 'invalid' };
  if (projectId === undefined || projectId.length === 0) return { kind: 'needs-project', accountId: value };
  const address = `${value}@${projectId}.iam.gserviceaccount.com`;
  return isServiceAccountEmail(address) ? { kind: 'address', address } : { kind: 'invalid' };
}
