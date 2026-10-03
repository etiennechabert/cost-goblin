/** GCP's project-ID shape: 6–30 characters of lowercase letters, digits and
 *  hyphens, starting with a letter and not ending with a hyphen. Legacy
 *  domain-scoped IDs (`example.com:my-project`) are deliberately not accepted;
 *  those setups can still write the config by hand. */
const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The rule above, worded for the user who broke it. */
export const GCP_PROJECT_ID_RULES = 'A project ID is 6–30 lowercase letters, digits or hyphens, starts with a letter and doesn’t end with a hyphen';

export function isValidGcpProjectId(raw: string): boolean {
  return GCP_PROJECT_ID_PATTERN.test(raw);
}
