import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportsStackQuickCreateUrl, HOSTED_EXPORTS_TEMPLATE_BASE_URL, hostedExportsTemplateUrl } from '../aws-setup/index.js';

// The README and costgoblin.com hardcode the "Launch the stack" link, and the
// site points at a README heading. These keep both in step with the code, so a
// moved template or a renamed heading fails here instead of in a reader's
// browser.

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const readme = readFileSync(join(repoRoot, 'README.md'), 'utf-8');
const site = readFileSync(join(repoRoot, 'docs', 'index.html'), 'utf-8');

/** GitHub's anchor for a Markdown heading: lowercase, punctuation dropped,
 *  spaces turned into hyphens. */
function githubAnchor(heading: string): string {
  return heading.trim().toLowerCase().replaceAll(/[^\p{L}\p{N}\s_-]/gu, '').replaceAll(/\s/g, '-');
}

describe('AWS setup docs', () => {
  it('launch the template releases publish, as the app does', () => {
    expect(HOSTED_EXPORTS_TEMPLATE_BASE_URL).not.toBeNull();
    if (HOSTED_EXPORTS_TEMPLATE_BASE_URL === null) return;
    const launch = exportsStackQuickCreateUrl(hostedExportsTemplateUrl(HOSTED_EXPORTS_TEMPLATE_BASE_URL, 'latest'), {});
    expect(readme).toContain(`(${launch})`);
    expect(site).toContain(`href="${launch.replaceAll('&', '&amp;')}"`);
  });

  it('only link README anchors that exist', () => {
    const anchors = new Set([
      ...[...readme.matchAll(/^#{1,6} (.+)$/gm)].map(match => githubAnchor(match[1] ?? '')),
      ...[...readme.matchAll(/<a id="([^"]+)"/g)].map(match => match[1] ?? ''),
    ]);
    const linked = [...site.matchAll(/github\.com\/etiennechabert\/cost-goblin#([\w-]+)/g)].map(match => match[1] ?? '');
    expect(linked).not.toHaveLength(0);
    for (const anchor of linked) expect(anchors).toContain(anchor);
  });
});
