// Electron wiring for the main-window trust model in window-security.ts: keep
// every WebContents on the app's own renderer document, refuse webviews, route
// window.open to the system browser, and deny permissions by default.
//
// Deny-only by design: a blocked navigation is dropped, never re-opened with
// shell.openExternal — will-navigate carries no user-gesture flag, so turning
// it into an external open would let a page launch URLs without a click.
// Links meant for the browser use target="_blank", which reaches the
// setWindowOpenHandler below.

import { app, session, shell } from 'electron';
import type { Event, WebContents } from 'electron';
import { logger } from '@costgoblin/core';
import { validateUrl, SecurityError } from './url-validator.js';
import { isPermissionAllowed, isTrustedNavigation, trustedRendererFromLoadedUrl } from './window-security.js';
import type { TrustedRenderer } from './window-security.js';

const trustByContents = new WeakMap<WebContents, TrustedRenderer>();

function trustOf(contents: WebContents): TrustedRenderer | null {
  return trustByContents.get(contents) ?? null;
}

/** Record the document `contents` just loaded as its only trusted renderer.
 *  Call right after the awaited loadFile/loadURL: trust comes from what was
 *  actually loaded (getURL()), not from what was asked for. When that is not
 *  recognisably the app (an error page, a UNC path), the window stays
 *  untrusted — every navigation and permission is then refused. */
export function markTrustedRenderer(contents: WebContents, devUrl: string | undefined): void {
  const loaded = contents.getURL();
  const trusted = trustedRendererFromLoadedUrl(loaded, devUrl);
  if (trusted === null) {
    logger.error('Main window loaded an unrecognised document; leaving it untrusted', { url: loaded });
    return;
  }
  trustByContents.set(contents, trusted);
}

interface NavigationDetails {
  readonly url: string;
  readonly isSameDocument: boolean;
}

function guardNavigation(contents: WebContents, eventName: string): (details: Event<NavigationDetails>) => void {
  return (details) => {
    if (details.isSameDocument) return;
    // DevTools is its own WebContents on devtools://; getURL() is still '' at
    // web-contents-created, so the exemption is decided at event time.
    if (contents.getURL().startsWith('devtools://')) return;
    if (isTrustedNavigation(details.url, trustOf(contents), process.platform)) return;
    details.preventDefault();
    logger.warn('Blocked navigation away from the app renderer', { event: eventName, url: details.url });
  };
}

function openExternally({ url }: { url: string }): { action: 'deny' } {
  try {
    validateUrl(url);
    shell.openExternal(url).catch(() => undefined);
  } catch (err) {
    if (err instanceof SecurityError) {
      logger.warn('Blocked dangerous URL in window.open', { url, error: err.message });
    }
  }
  return { action: 'deny' };
}

/** Install the per-WebContents guards. Must run before the first
 *  BrowserWindow is constructed: web-contents-created fires inside
 *  `new BrowserWindow`, before any load. */
export function installWebContentsGuards(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-frame-navigate', guardNavigation(contents, 'will-frame-navigate'));
    contents.on('will-navigate', guardNavigation(contents, 'will-navigate'));
    contents.on('will-redirect', guardNavigation(contents, 'will-redirect'));
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      logger.warn('Blocked <webview> attach');
    });
    contents.setWindowOpenHandler(openExternally);
  });
}

/** Deny every permission except clipboard-sanitized-write from the trusted
 *  renderer. Uses the requesting URL, never requestingOrigin (file:// origins
 *  are opaque, so an origin match would accept any local file). */
export function installPermissionHandlers(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, trustOf(contents), process.platform));
  });
  ses.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) => {
    if (contents === null) return false;
    const requestingUrl = details.requestingUrl ?? contents.getURL();
    return isPermissionAllowed(permission, requestingUrl, trustOf(contents), process.platform);
  });
}
