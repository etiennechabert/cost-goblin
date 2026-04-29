import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers.js';

let app: ElectronApplication;
let page: Page;
let cspHeader: string;

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();

  const captured = new Promise<string>((resolve) => {
    page.on('response', (response) => {
      const csp = response.headers()['content-security-policy'];
      if (csp) resolve(csp);
    });
  });

  await page.reload();
  cspHeader = await captured;
});

test.afterAll(async () => {
  await app.close();
});

test('CSP header contains required directives', () => {
  expect(cspHeader).toContain("default-src 'self'");
  expect(cspHeader).toContain("script-src 'self'");
  expect(cspHeader).toContain("connect-src 'self'");
  expect(cspHeader).toContain("style-src 'self' 'unsafe-inline'");
  expect(cspHeader).toContain("img-src 'self' data: blob:");
  expect(cspHeader).toContain("font-src 'self' data:");
});

test('CSP does not allow unsafe-inline for scripts', () => {
  const scriptSrc = cspHeader.match(/script-src\s+[^;]+/);
  expect(scriptSrc?.[0]).toBe("script-src 'self'");
});
