import { EXPORTS_STACK_NAME, EXPORTS_STACK_PARAMETERS } from './exports-stack.js';
import type { ExportsStackDefaults } from './exports-stack.js';

// Phase 4 of docs/aws-one-click-setup-design.md: a prefilled "quick-create"
// link instead of saving and uploading the template. The console only takes a
// template stored in S3, so each release uploads it (release.yml,
// publish-template) to a public bucket the maintainer deploys with
// scripts/aws-exports/hosting/template-hosting.yaml.

/** Where releases publish the template, e.g.
 *  `https://<bucket>.s3.amazonaws.com/templates`. Null until that bucket
 *  exists: the wizard then saves the template for upload instead. Set it to
 *  the hosting stack's `TemplateBaseUrl` output. */
export const HOSTED_EXPORTS_TEMPLATE_BASE_URL: string | null = null;

/** The template a release published (`<base>/v<version>/…`), or the latest
 *  release's, for a development build whose version isn't published yet. */
export function hostedExportsTemplateUrl(base: string, release: string): string {
  const folder = release === 'latest' ? 'latest' : `v${release}`;
  return `${base}/${folder}/costgoblin-exports.yaml`;
}

/** The hosted template for this build, or null while nothing is hosted. */
export function hostedTemplateUrlForBuild(base: string | null, build: { readonly packaged: boolean; readonly version: string }): string | null {
  if (base === null) return null;
  return hostedExportsTemplateUrl(base, build.packaged ? build.version : 'latest');
}

/** The documented quick-create route (cfn-console-create-stacks-quick-create-links). */
const QUICK_CREATE = 'https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review';

/** The console's quick-create page for the stack, with the wizard's answers
 *  as parameters. Unanswered ones are left out, so the template's defaults
 *  apply. */
export function exportsStackQuickCreateUrl(templateUrl: string, defaults: ExportsStackDefaults): string {
  const params = new URLSearchParams({ templateURL: templateUrl, stackName: EXPORTS_STACK_NAME });
  const yesNo = (value: boolean): string => (value ? 'yes' : 'no');
  if (defaults.bucketName !== undefined) params.set(`param_${EXPORTS_STACK_PARAMETERS.bucketName}`, defaults.bucketName);
  if (defaults.hourly !== undefined) params.set(`param_${EXPORTS_STACK_PARAMETERS.hourly}`, yesNo(defaults.hourly));
  if (defaults.costOptimization !== undefined) params.set(`param_${EXPORTS_STACK_PARAMETERS.costOptimization}`, yesNo(defaults.costOptimization));
  if (defaults.serviceRole !== undefined) params.set(`param_${EXPORTS_STACK_PARAMETERS.serviceRole}`, yesNo(defaults.serviceRole));
  return `${QUICK_CREATE}?${params.toString()}`;
}
