// Pure trust decisions for the main window: which document is "the app", which
// navigations and permission requests it may make, and the CSP it runs under.
//
// PURE and import-type-only on purpose: preload.ts bundles this file, and a
// sandboxed preload cannot load `node:` modules or anything that pulls them in
// (including @costgoblin/core's logger). Keep every import here `import type`.

/** The one document the main window is allowed to show. `file` is the packaged
 *  (and e2e) renderer loaded with `loadFile`; `dev` is the electron-vite dev
 *  server, trusted by origin because Vite serves many module URLs from it. */
export type TrustedRenderer =
  | { readonly kind: 'file'; readonly url: URL }
  | { readonly kind: 'dev'; readonly origin: string };

/** The additionalArguments switch main.ts passes so the preload knows which
 *  document the bridge belongs to. */
export const RENDERER_ARG_PREFIX = '--costgoblin-renderer=';

/** The only permission the renderer needs: the copy buttons' clipboard.writeText. */
const ALLOWED_PERMISSION = 'clipboard-sanitized-write';

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Decode each run of `%XX` escapes, leaving a run raw when it is not valid
 *  UTF-8. `loadFile` leaves `%` and `[` raw in the URL it navigates to while
 *  `pathToFileURL` escapes them, so only decoded pathnames compare safely. */
export function decodePathLeniently(path: string): string {
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

function devOrigin(devUrl: string | undefined): string | null {
  if (devUrl === undefined) return null;
  const parsed = parseUrl(devUrl);
  if (parsed === null) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/** The trust to record for a window from the URL it actually loaded
 *  (`webContents.getURL()` after the awaited load). Null for anything that is
 *  not the app renderer — an error page, about:blank, a hosted file:// path,
 *  or an http(s) page that is not the configured dev server. */
export function trustedRendererFromLoadedUrl(loaded: string, devUrl: string | undefined): TrustedRenderer | null {
  const parsed = parseUrl(loaded);
  if (parsed === null) return null;
  if (parsed.protocol === 'file:') {
    // A non-empty host is a UNC/network path (file://server/share on Windows
    // would leak NTLM credentials) — never the app's own install.
    if (parsed.host !== '') return null;
    parsed.hash = '';
    parsed.search = '';
    return { kind: 'file', url: parsed };
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const origin = devOrigin(devUrl);
    if (origin !== null && parsed.origin === origin) return { kind: 'dev', origin };
  }
  return null;
}

function comparablePath(url: URL, platform: NodeJS.Platform): string {
  const decoded = decodePathLeniently(url.pathname);
  return platform === 'win32' ? decoded.toLowerCase() : decoded;
}

/** Whether `target` is the trusted renderer document (hash and query ignored)
 *  or, for the dev server, anything on its origin. False for a null trust or
 *  an unparsable target. */
export function isTrustedNavigation(target: string, trusted: TrustedRenderer | null, platform: NodeJS.Platform): boolean {
  if (trusted === null) return false;
  const parsed = parseUrl(target);
  if (parsed === null) return false;
  if (trusted.kind === 'dev') {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.origin === trusted.origin;
  }
  if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
  return comparablePath(parsed, platform) === comparablePath(trusted.url, platform);
}

/** The trust main.ts handed the preload via additionalArguments. The last
 *  `--costgoblin-renderer=` entry wins; a missing or garbled one is null, so
 *  the preload exposes nothing. */
export function trustedRendererFromArgv(argv: readonly string[]): TrustedRenderer | null {
  let value: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith(RENDERER_ARG_PREFIX)) value = arg.slice(RENDERER_ARG_PREFIX.length);
  }
  if (value === null) return null;
  return trustedRendererFromLoadedUrl(value, value);
}

/** Deny-by-default permission policy: only `clipboard-sanitized-write`, and
 *  only when the request comes from the trusted renderer document. */
export function isPermissionAllowed(
  permission: string,
  requestingUrl: string | undefined,
  trusted: TrustedRenderer | null,
  platform: NodeJS.Platform,
): boolean {
  if (permission !== ALLOWED_PERMISSION) return false;
  if (requestingUrl === undefined) return false;
  return isTrustedNavigation(requestingUrl, trusted, platform);
}

/** The Content-Security-Policy stamped on every response. The dev policy
 *  keeps 'unsafe-inline' scripts and ws: for Vite's HMR client. */
export function buildCsp(isDev: boolean): string {
  const directives = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws:",
      ]
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
      ];
  return [...directives, "base-uri 'none'", "form-action 'none'"].join('; ');
}
