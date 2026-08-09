import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  FIXTURE_CONFIG_DIR,
  clickNavButton,
  launchApp,
  closeApp,
  startCoverage,
  stopAndCollectCoverage,
  waitForQuerySettle,
  writeCoverage,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Widget growth regression — every widget × every size stays bounded
// ---------------------------------------------------------------------------
test.describe('Widget growth', () => {
  const TEMP_CONFIG_DIR = join(tmpdir(), `costgoblin-widget-growth-${String(Date.now())}`);
  const VIEWS_YAML = buildWidgetMatrixYaml();

  const WIDGET_TYPES = ['summary', 'pie', 'stackedBar', 'line', 'topNBar', 'treemap', 'heatmap', 'bubble', 'table'] as const;

  let widgetApp: ElectronApplication;
  let widgetPage: Page;
  const allCoverage: unknown[] = [];

  test.beforeAll(async () => {
    mkdirSync(TEMP_CONFIG_DIR, { recursive: true });
    for (const f of ['costgoblin.yaml', 'dimensions.yaml', 'org-tree.yaml']) {
      const src = join(FIXTURE_CONFIG_DIR, f);
      if (existsSync(src)) writeFileSync(join(TEMP_CONFIG_DIR, f), readFileSync(src));
    }
    writeFileSync(join(TEMP_CONFIG_DIR, 'views.yaml'), VIEWS_YAML);

    widgetApp = await launchApp({ configDir: TEMP_CONFIG_DIR });
    widgetPage = await widgetApp.firstWindow();
    // Attach as early as possible: CDP coverage only counts execution after
    // enabling, so every await before this line is boot code lost to the report.
    await startCoverage(widgetPage);
    await expect(widgetPage).toHaveTitle('CostGoblin');
    await widgetPage.setViewportSize({ width: 1400, height: 900 });
  });

  test.afterAll(async () => {
    await stopAndCollectCoverage(widgetPage, allCoverage);
    // Write before close: a hung or rejected close() must not discard the
    // coverage already harvested (writeCoverage is synchronous).
    writeCoverage('stress', allCoverage);
    await closeApp(widgetApp);
  });

  for (const widgetType of WIDGET_TYPES) {
    test(`${widgetType} stays bounded at all sizes`, async () => {
      await clickNavButton(widgetPage, `test-${widgetType}`);
      await waitForQuerySettle(widgetPage);
      // Let queries resolve, loaders swap to real data, and any one-shot
      // layout transitions settle — we're hunting runaway growth, not
      // legitimate data-arrival reflows.
      await widgetPage.waitForTimeout(4000);

      // Sample every 600ms for ~3 seconds. Runaway growth shows up as
      // sample-to-sample increases.
      const samples: { bodyWidth: number; bodyHeight: number }[] = [];
      for (let i = 0; i < 5; i++) {
        const m = await widgetPage.evaluate(() => ({
          bodyWidth: document.body.scrollWidth,
          bodyHeight: document.body.scrollHeight,
        }));
        samples.push(m);
        await widgetPage.waitForTimeout(600);
      }

      // Growth check: no single inter-sample gap should exceed 20px. A runaway
      // grower accumulates ~100s of px per second; legitimate reflows land in
      // the first sample and stay put.
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const cur = samples[i];
        if (prev === undefined || cur === undefined) continue;
        expect(cur.bodyWidth - prev.bodyWidth, `width grew between samples ${String(i - 1)}→${String(i)} for ${widgetType}`).toBeLessThan(20);
        expect(cur.bodyHeight - prev.bodyHeight, `height grew between samples ${String(i - 1)}→${String(i)} for ${widgetType}`).toBeLessThan(20);
      }
    });
  }
});

function buildWidgetMatrixYaml(): string {
  const types = ['summary', 'pie', 'stackedBar', 'line', 'topNBar', 'treemap', 'heatmap', 'bubble', 'table'] as const;
  const sizes = ['small', 'medium', 'large', 'full'] as const;
  const views: string[] = [];
  // Keep the seed Cost Overview so the app boots into a working state. It's
  // also built-in so it can't be deleted by the test.
  views.push(`  - id: overview
    name: Cost Overview
    builtIn: true
    rows:
      - widgets:
          - id: ov-sum
            type: summary
            size: small
            metric: total`);
  for (const t of types) {
    const widgetLines: string[] = [];
    for (const [i, size] of sizes.entries()) {
      const id = `w-${t}-${size}`;
      if (t === 'summary') {
        widgetLines.push(`      - widgets:\n          - id: ${id}\n            type: summary\n            size: ${size}\n            metric: total`);
      } else {
        const extras = t === 'topNBar' || t === 'line' || t === 'heatmap' || t === 'table'
          ? `\n            topN: 10`
          : '';
        const columns = t === 'table' ? `\n            columns: [entity, service, cost, percentage]` : '';
        widgetLines.push(`      - widgets:\n          - id: ${id}\n            type: ${t}\n            size: ${size}\n            groupBy: service${extras}${columns}`);
      }
      void i;
    }
    views.push(`  - id: test-${t}
    name: test-${t}
    rows:
${widgetLines.join('\n')}`);
  }
  return `views:\n${views.join('\n')}\n`;
}
