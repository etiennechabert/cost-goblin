import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'yaml';
import { ConfigValidationError, dimensionsConfigToYaml, validateDimensions } from '@costgoblin/core';
import { buildWizardDimensions } from '../main/setup-dimensions.js';

describe('buildWizardDimensions', () => {
  it('scaffolds the default built-ins, minus the ones a gcp export cannot fill', () => {
    const aws = buildWizardDimensions('aws', undefined);
    expect(aws.builtIn.map(d => String(d.name))).toEqual([
      'account', 'region', 'service', 'service_category', 'charge_category', 'sku_meter', 'operation',
    ]);
    expect(aws.tags).toEqual([]);
    const gcp = buildWizardDimensions('gcp', undefined);
    expect(gcp.builtIn.map(d => String(d.name))).toEqual(['account', 'region', 'service', 'charge_category']);
  });

  it('keeps the fields the wizard collects for each tag', () => {
    const dims = buildWizardDimensions('aws', [
      { tagName: 'team', label: 'Team', concept: 'owner' },
      { tagName: 'env', label: 'Environment' },
    ]);
    expect(dims.tags).toEqual([
      { tagName: 'team', label: 'Team', concept: 'owner' },
      { tagName: 'env', label: 'Environment' },
    ]);
  });

  // `tags` comes from the renderer. Written unvalidated, an entry the next
  // load rejects replaced a working dimensions.yaml, and the app could no
  // longer load its dimensions at all.
  it.each([
    ['a quote in a tagName', [{ tagName: "te'am", label: 'Team' }]],
    ['a NUL in a tagName', [{ tagName: 'te\u0000am', label: 'Team' }]],
    ['a missing tagName', [{ label: 'Team' }]],
    ['a non-string label', [{ tagName: 'team', label: 42 }]],
    ['an unknown concept', [{ tagName: 'team', label: 'Team', concept: 'boss' }]],
    ['a null entry', [null]],
    ['a non-array', { tagName: 'team', label: 'Team' }],
  ])('rejects %s', (_label, tags) => {
    expect(() => buildWizardDimensions('aws', tags)).toThrow(ConfigValidationError);
  });

  it('writes a file the next load accepts unchanged', () => {
    const dims = buildWizardDimensions('gcp', [{ tagName: 'team', label: 'Team', concept: 'owner' }]);
    expect(validateDimensions(parse(stringify(dimensionsConfigToYaml(dims))))).toEqual(dims);
  });
});
