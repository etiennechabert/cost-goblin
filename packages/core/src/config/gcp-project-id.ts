/** GCP's project-ID shape: 6–30 characters of lowercase letters, digits and
 *  hyphens, starting with a letter and not ending with a hyphen.
 *
 *  Used where the setup wizard accepts a TYPED project ID — the
 *  least-privilege account (Token Creator on the read-only reader, nothing at
 *  project level) cannot `gcloud projects list` its own project. Legacy
 *  domain-scoped IDs (`example.com:my-project`) are deliberately not accepted;
 *  those setups can still write the config by hand. */
export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function isValidGcpProjectId(raw: string): boolean {
  return GCP_PROJECT_ID_PATTERN.test(raw);
}
