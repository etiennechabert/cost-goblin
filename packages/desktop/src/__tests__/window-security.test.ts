import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  buildCsp,
  decodePathLeniently,
  isPermissionAllowed,
  isTrustedNavigation,
  trustedRendererFromArgv,
  trustedRendererFromLoadedUrl,
  type TrustedRenderer,
} from '../main/window-security.js';

const RENDERER_DIR = 'file:///Applications/CostGoblin.app/Contents/Resources/app.asar/out/renderer';
const T = `${RENDERER_DIR}/index.html`;
const T_PATH = '/Applications/CostGoblin.app/Contents/Resources/app.asar/out/renderer/index.html';
const DEV_URL = 'http://localhost:5173';

function fileTrust(url: string): TrustedRenderer | null {
  return trustedRendererFromLoadedUrl(url, undefined);
}

const trusted = fileTrust(T);

describe('decodePathLeniently', () => {
  it('decodes valid percent-escape runs', () => {
    expect(decodePathLeniently('/a%20b/%69ndex.html')).toBe('/a b/index.html');
    expect(decodePathLeniently('/%5Bx%5D/index.html')).toBe('/[x]/index.html');
  });

  it('leaves invalid escapes raw instead of throwing', () => {
    expect(decodePathLeniently('/a%b/x')).toBe('/a%b/x');
    expect(decodePathLeniently('/a%zz/x')).toBe('/a%zz/x');
    // %C3 alone is not valid UTF-8 — the run stays raw, the rest still decodes.
    expect(decodePathLeniently('/%C3/%20')).toBe('/%C3/ ');
  });
});

describe('trustedRendererFromLoadedUrl', () => {
  it('trusts the loaded renderer file, stripping hash and query', () => {
    const t = trustedRendererFromLoadedUrl(`${T}?x=1#/costs`, undefined);
    expect(t?.kind).toBe('file');
    if (t?.kind === 'file') {
      expect(t.url.href).toBe(T);
    }
  });

  it('trusts the dev server origin only when it matches devUrl', () => {
    expect(trustedRendererFromLoadedUrl(`${DEV_URL}/`, DEV_URL)).toEqual({ kind: 'dev', origin: DEV_URL });
    expect(trustedRendererFromLoadedUrl('http://localhost:5174/', DEV_URL)).toBeNull();
  });

  it('returns null for anything that is not the app renderer', () => {
    expect(trustedRendererFromLoadedUrl('chrome-error://chromewebdata/', undefined)).toBeNull();
    expect(trustedRendererFromLoadedUrl('about:blank', undefined)).toBeNull();
    expect(trustedRendererFromLoadedUrl('http://localhost:5173/', undefined)).toBeNull();
    expect(trustedRendererFromLoadedUrl('https://github.com/', undefined)).toBeNull();
    expect(trustedRendererFromLoadedUrl('file://host/x', undefined)).toBeNull();
    expect(trustedRendererFromLoadedUrl('not a url', undefined)).toBeNull();
    expect(trustedRendererFromLoadedUrl('', undefined)).toBeNull();
  });

  it('never treats a non-http(s) devUrl as a dev origin', () => {
    expect(trustedRendererFromLoadedUrl('javascript:alert(1)', 'javascript:alert(1)')).toBeNull();
    expect(trustedRendererFromLoadedUrl('data:text/html,x', 'data:text/html,x')).toBeNull();
  });
});

describe('isTrustedNavigation — packaged file renderer', () => {
  it.each([
    T,
    `${T}#/costs`,
    `${T}?x=1`,
    `${RENDERER_DIR}/%69ndex.html`,
    `${RENDERER_DIR}/%2e%2e/renderer/index.html`,
  ])('allows %s', (target) => {
    expect(isTrustedNavigation(target, trusted, 'darwin')).toBe(true);
  });

  it.each([
    `${RENDERER_DIR}/other.html`,
    `file://evilhost${T_PATH}`,
    'file:///Users/v/Downloads/evil.html',
    'https://github.com/o/r/pull/1',
    'javascript:alert(1)',
    'about:blank',
    'chrome-error://chromewebdata/',
    'devtools://devtools/bundled/inspector.html',
    'not a url',
    '',
  ])('denies %s', (target) => {
    expect(isTrustedNavigation(target, trusted, 'darwin')).toBe(false);
  });

  it('denies everything when there is no trust', () => {
    expect(isTrustedNavigation(T, null, 'darwin')).toBe(false);
  });

  it('matches loadFile raw % and [ forms against a pathToFileURL trust', () => {
    for (const path of ['/Users/a%b/x/index.html', '/Users/[x]/index.html']) {
      const trust = fileTrust(pathToFileURL(path).href);
      expect(trust).not.toBeNull();
      // loadFile leaves '%' and '[' raw in the URL it navigates to.
      expect(isTrustedNavigation(`file://${path}`, trust, 'darwin')).toBe(true);
      expect(isTrustedNavigation(`file://${path}#/costs`, trust, 'darwin')).toBe(true);
      expect(isTrustedNavigation('file:///Users/other/index.html', trust, 'darwin')).toBe(false);
    }
  });
});

describe('isTrustedNavigation — win32 paths', () => {
  const winTrust = fileTrust('file:///C:/Program%20Files/CostGoblin/resources/app.asar/out/renderer/index.html');
  const lower = 'file:///c:/program%20files/costgoblin/resources/app.asar/out/renderer/index.html';

  it('compares case-insensitively on win32 only', () => {
    expect(winTrust).not.toBeNull();
    expect(isTrustedNavigation(lower, winTrust, 'win32')).toBe(true);
    expect(isTrustedNavigation(lower, winTrust, 'darwin')).toBe(false);
  });

  it('rejects UNC-style hosts even on win32', () => {
    expect(isTrustedNavigation(
      'file://attacker/C:/Program%20Files/CostGoblin/resources/app.asar/out/renderer/index.html',
      winTrust,
      'win32',
    )).toBe(false);
  });
});

describe('isTrustedNavigation — dev server renderer', () => {
  const devTrust = trustedRendererFromLoadedUrl(`${DEV_URL}/`, DEV_URL);

  it('allows the dev origin', () => {
    expect(isTrustedNavigation(`${DEV_URL}/src/x`, devTrust, 'darwin')).toBe(true);
    expect(isTrustedNavigation(`${DEV_URL}/`, devTrust, 'darwin')).toBe(true);
  });

  it('denies other ports and look-alike hosts', () => {
    expect(isTrustedNavigation('http://localhost:5174/src/x', devTrust, 'darwin')).toBe(false);
    expect(isTrustedNavigation('http://localhost.evil.test:5173/', devTrust, 'darwin')).toBe(false);
    expect(isTrustedNavigation(T, devTrust, 'darwin')).toBe(false);
  });
});

describe('trustedRendererFromArgv', () => {
  it('returns null when the flag is missing or garbled', () => {
    expect(trustedRendererFromArgv([])).toBeNull();
    expect(trustedRendererFromArgv(['electron', '--other=1'])).toBeNull();
    expect(trustedRendererFromArgv(['--costgoblin-renderer='])).toBeNull();
    expect(trustedRendererFromArgv(['--costgoblin-renderer=not a url'])).toBeNull();
    expect(trustedRendererFromArgv(['--costgoblin-renderer=javascript:alert(1)'])).toBeNull();
    expect(trustedRendererFromArgv(['--costgoblin-renderer=about:blank'])).toBeNull();
    expect(trustedRendererFromArgv(['--costgoblin-renderer=file://host/x'])).toBeNull();
  });

  it('parses a file trust and a dev trust', () => {
    const f = trustedRendererFromArgv(['electron', `--costgoblin-renderer=${T}`]);
    expect(isTrustedNavigation(T, f, 'darwin')).toBe(true);
    expect(trustedRendererFromArgv([`--costgoblin-renderer=${DEV_URL}`]))
      .toEqual({ kind: 'dev', origin: DEV_URL });
  });

  it('uses the last entry when repeated', () => {
    const t = trustedRendererFromArgv([
      `--costgoblin-renderer=${T}`,
      `--costgoblin-renderer=${DEV_URL}`,
    ]);
    expect(t).toEqual({ kind: 'dev', origin: DEV_URL });
    expect(trustedRendererFromArgv([
      `--costgoblin-renderer=${T}`,
      '--costgoblin-renderer=garbage',
    ])).toBeNull();
  });
});

describe('isPermissionAllowed', () => {
  it('allows only clipboard-sanitized-write from the trusted renderer', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', T, trusted, 'darwin')).toBe(true);
    expect(isPermissionAllowed('clipboard-sanitized-write', `${T}#/costs`, trusted, 'darwin')).toBe(true);
  });

  it('denies clipboard-sanitized-write from anywhere else', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', 'https://github.com/', trusted, 'darwin')).toBe(false);
    expect(isPermissionAllowed('clipboard-sanitized-write', 'file:///tmp/evil.html', trusted, 'darwin')).toBe(false);
    expect(isPermissionAllowed('clipboard-sanitized-write', undefined, trusted, 'darwin')).toBe(false);
    expect(isPermissionAllowed('clipboard-sanitized-write', T, null, 'darwin')).toBe(false);
  });

  it.each([
    'geolocation',
    'media',
    'notifications',
    'openExternal',
    'fullscreen',
    'clipboard-read',
  ])('denies %s even from the trusted renderer', (permission) => {
    expect(isPermissionAllowed(permission, T, trusted, 'darwin')).toBe(false);
  });
});

describe('buildCsp', () => {
  function directives(csp: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of csp.split(';')) {
      const [name, ...values] = part.trim().split(/\s+/);
      if (name !== undefined && name !== '') out.set(name, values.join(' '));
    }
    return out;
  }

  it('production policy adds base-uri and form-action and stays strict', () => {
    const d = directives(buildCsp(false));
    expect(d.get('base-uri')).toBe("'none'");
    expect(d.get('form-action')).toBe("'none'");
    expect(d.get('script-src')).toBe("'self'");
    expect(d.get('connect-src')).toBe("'self'");
    expect(buildCsp(false)).not.toContain('ws:');
    expect(d.get('default-src')).toBe("'self'");
    expect(d.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(d.get('img-src')).toBe("'self' data: blob:");
    expect(d.get('font-src')).toBe("'self' data:");
  });

  it('dev policy keeps its relaxations and gains both directives', () => {
    const d = directives(buildCsp(true));
    expect(d.get('base-uri')).toBe("'none'");
    expect(d.get('form-action')).toBe("'none'");
    expect(d.get('script-src')).toBe("'self' 'unsafe-inline'");
    expect(d.get('connect-src')).toBe("'self' ws:");
  });
});
