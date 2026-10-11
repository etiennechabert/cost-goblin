import { describe, expect, it } from 'vitest';
import { EXPORTS_STACK_NAME, exportsStackQuickCreateUrl, HOSTED_EXPORTS_TEMPLATE_BASE_URL, hostedExportsTemplateUrl, hostedTemplateUrlForBuild } from '../aws-setup/index.js';

const BASE = 'https://costgoblin-templates.s3.amazonaws.com/templates';

describe('HOSTED_EXPORTS_TEMPLATE_BASE_URL', () => {
  // The hosting stack's TemplateBaseUrl output; release.yml uploads under it.
  it('is a regional S3 URL the quick-create page accepts, without a trailing slash', () => {
    expect(HOSTED_EXPORTS_TEMPLATE_BASE_URL).toMatch(/^https:\/\/[a-z0-9.-]+\.s3\.[a-z0-9-]+\.amazonaws\.com\/templates$/);
  });
});

describe('hostedExportsTemplateUrl', () => {
  it('points a release at the template its tag published', () => {
    expect(hostedExportsTemplateUrl(BASE, '0.9.0')).toBe(`${BASE}/v0.9.0/costgoblin-exports.yaml`);
  });

  it('points a development build at the latest release', () => {
    expect(hostedExportsTemplateUrl(BASE, 'latest')).toBe(`${BASE}/latest/costgoblin-exports.yaml`);
  });
});

describe('hostedTemplateUrlForBuild', () => {
  it('has nothing to offer while no bucket hosts the template', () => {
    expect(hostedTemplateUrlForBuild(null, { packaged: true, version: '0.9.0' })).toBeNull();
  });

  it("gives a packaged release its own tag's template", () => {
    expect(hostedTemplateUrlForBuild(BASE, { packaged: true, version: '0.9.0' })).toBe(`${BASE}/v0.9.0/costgoblin-exports.yaml`);
  });

  it('gives a development build, whose version is not published yet, the latest one', () => {
    expect(hostedTemplateUrlForBuild(BASE, { packaged: false, version: '0.9.0' })).toBe(`${BASE}/latest/costgoblin-exports.yaml`);
  });
});

describe('exportsStackQuickCreateUrl', () => {
  const templateUrl = `${BASE}/v0.9.0/costgoblin-exports.yaml`;

  // AWS documents quick-create links as #/stacks/create/review?templateURL=…
  // (cfn-console-create-stacks-quick-create-links).
  it('opens a prefilled quick-create page in us-east-1', () => {
    const url = new URL(exportsStackQuickCreateUrl(templateUrl, { bucketName: 'acme-billing', hourly: true, costOptimization: false, serviceRole: true }));
    expect(url.origin).toBe('https://us-east-1.console.aws.amazon.com');
    expect(url.searchParams.get('region')).toBe('us-east-1');
    // The console reads the stack's settings from the fragment.
    expect(url.hash.startsWith('#/stacks/create/review?')).toBe(true);
    const params = new URLSearchParams(url.hash.slice('#/stacks/create/review?'.length));
    expect(params.get('templateURL')).toBe(templateUrl);
    expect(params.get('stackName')).toBe(EXPORTS_STACK_NAME);
    expect(params.get('param_BucketName')).toBe('acme-billing');
    expect(params.get('param_CreateHourlyExport')).toBe('yes');
    expect(params.get('param_CreateCostOptimizationExport')).toBe('no');
    expect(params.get('param_CreateDataExportsServiceRole')).toBe('yes');
  });

  it('leaves out what the user did not choose, so the template defaults apply', () => {
    const params = new URLSearchParams(new URL(exportsStackQuickCreateUrl(templateUrl, {})).hash.slice('#/stacks/create/review?'.length));
    expect([...params.keys()]).toEqual(['templateURL', 'stackName']);
  });
});
