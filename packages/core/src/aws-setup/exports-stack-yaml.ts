import { stringify } from 'yaml';
import { buildExportsStackTemplate } from './exports-stack.js';
import type { ExportsStackDefaults } from './exports-stack.js';

// Kept apart from exports-stack.ts so the renderer's bundle, which only needs
// the layout and parameter names, never pulls in the YAML library.

const HEADER = [
  '# CostGoblin billing exports. Create this stack in us-east-1:',
  '# CloudFormation > Create stack > With new resources > Upload a template file.',
  '#',
  '# Generated from packages/core/src/aws-setup/exports-stack.ts by',
  '# scripts/aws-exports/write-template.ts. Do not edit by hand.',
  '',
].join('\n');

/** The stack's template as YAML, with the wizard's answers as defaults. */
export function renderExportsStackYaml(defaults: ExportsStackDefaults = {}): string {
  // YAML 1.1, the rules CloudFormation can read a template by: they quote
  // `yes`, `no` and date-like versions, which 1.1 would otherwise read as
  // booleans and timestamps. lineWidth 0 keeps each SELECT on one line, as
  // Data Exports' console shows it.
  return HEADER + stringify(buildExportsStackTemplate(defaults), { version: '1.1', lineWidth: 0 });
}
