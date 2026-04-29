/**
 * Error thrown when URL validation fails.
 * Prevents shell.openExternal from opening dangerous URLs with malicious
 * protocol handlers (file://, javascript:, data:, smb://, custom://, etc.).
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Allowed URL protocols for shell.openExternal.
 * Only https:// and http:// are safe for user-initiated navigation.
 * All other protocols (file://, javascript:, data:, smb://, custom://, etc.)
 * can trigger dangerous behavior:
 * - file:// can access local filesystem
 * - javascript: executes code
 * - data: can contain executable content
 * - smb:// can trigger network auth dialogs or connect to malicious servers
 * - custom:// protocols can launch arbitrary applications
 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

/**
 * Validate a URL before passing it to shell.openExternal.
 * Only https:// and http:// protocols are allowed.
 *
 * @param url - The URL to validate (from window.open or click events)
 * @throws {SecurityError} If the URL protocol is not in the allow-list or the URL is malformed
 *
 * @example
 * ```typescript
 * // Safe URLs — these pass validation
 * validateUrl('https://example.com');
 * validateUrl('http://docs.aws.amazon.com');
 *
 * // Dangerous URLs — these throw SecurityError
 * validateUrl('file:///etc/passwd');
 * validateUrl('javascript:alert(1)');
 * validateUrl('data:text/html,<script>alert(1)</script>');
 * validateUrl('smb://evil.com/share');
 * validateUrl('custom://launch-app');
 * ```
 */
export function validateUrl(url: string): void {
  // Parse the URL to extract the protocol
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecurityError(
      `Malformed URL "${url}" - cannot parse. ` +
      `This prevents shell.openExternal from opening invalid URLs.`
    );
  }

  // Validate protocol is in allow-list
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SecurityError(
      `Dangerous URL protocol "${parsed.protocol}" in URL "${url}" - ` +
      `only https:// and http:// are allowed. ` +
      `This prevents shell.openExternal from launching malicious protocol handlers ` +
      `(file://, javascript:, data:, smb://, custom://, etc.).`
    );
  }
}
