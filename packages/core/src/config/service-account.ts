/** The address grammar of a GCP service account: a 6–30 character account id
 *  (lowercase letter first, lowercase alphanumerics and hyphens, no trailing
 *  hyphen) at `<project>.iam.gserviceaccount.com`.
 *
 *  Leaf module with no imports, so the setup wizard can check the field it
 *  collects with the exact rule the config validator applies — and so the
 *  main process can re-check a value arriving over IPC before it reaches a
 *  gcloud argv array or an impersonation request. */
const SERVICE_ACCOUNT_EMAIL_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

export function isServiceAccountEmail(value: string): boolean {
  return SERVICE_ACCOUNT_EMAIL_PATTERN.test(value);
}
