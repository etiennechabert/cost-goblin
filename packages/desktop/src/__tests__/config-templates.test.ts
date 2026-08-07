import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';
import { validateConfig, validateDimensions } from '@costgoblin/core';
import { buildConfigTemplate, buildDimensionsTemplate } from '../main/config-templates.js';
import type { TemplateProviderType } from '../main/config-templates.js';

const TYPES: TemplateProviderType[] = ['aws', 'gcp'];

describe('scaffolded config templates', () => {
  // The whole point of the templates: a workspace with no config gets one the
  // app can actually start from. A stray indent in the commented alternative
  // block would otherwise strand the user on an app that refuses to launch,
  // with no clue which line is wrong.
  it.each(TYPES)('%s config parses and passes the real validator', (type) => {
    const config = validateConfig(parse(buildConfigTemplate(type)));
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.type).toBe(type);
  });

  it.each(TYPES)('%s dimensions parse and pass the real validator', (type) => {
    expect(() => validateDimensions(parse(buildDimensionsTemplate(type)))).not.toThrow();
  });

  it('points each arm at its own object store', () => {
    expect(String(validateConfig(parse(buildConfigTemplate('aws'))).providers[0]?.sync.daily.bucket)).toMatch(/^s3:\/\//);
    expect(String(validateConfig(parse(buildConfigTemplate('gcp'))).providers[0]?.sync.daily.bucket)).toMatch(/^gs:\/\//);
  });

  it('leaves the other provider commented out, not active', () => {
    // Both arms are shown so adding the second is uncommenting rather than
    // looking up the shape — but only one may be live, or the app starts by
    // trying to reach a placeholder bucket on a cloud the user does not use.
    for (const type of TYPES) {
      const template = buildConfigTemplate(type);
      const other = type === 'aws' ? 'gcp' : 'aws';
      expect(template.includes(`\n    type: ${type}\n`), type).toBe(true);
      expect(template.includes(`\n    type: ${other}\n`), type).toBe(false);
      expect(validateConfig(parse(template)).providers, type).toHaveLength(1);
    }
  });

  it.each(TYPES)('%s: uncommenting the other provider yields a valid two-provider config', (type) => {
    // The block invites the user to uncomment it, so that has to actually
    // work. Commenting with `# ${line.trimStart()}` instead of `# ${line}`
    // flattens every indent level to one column, and stripping the markers
    // then produces `- name:` and `type:` as siblings — YAML the app refuses
    // to load, with nothing to say which line is wrong.
    const template = buildConfigTemplate(type);
    // What a user does: strip the marker from the commented YAML block. The
    // prose above it is `# ` followed by a letter; every block line is `# `
    // followed by the line's own indentation, so the two are distinguishable
    // by eye and by this rule.
    const uncommented = template
      .split('\n')
      .map(l => (/^# \s/.test(l) ? l.replace(/^# /, '') : l))
      .join('\n');

    const config = validateConfig(parse(uncommented));
    expect(config.providers.map(p => p.type).sort()).toEqual(['aws', 'gcp']);
    // Both providers keep their own bucket scheme — proof the indentation
    // survived and the tiers did not collapse into one provider.
    const buckets = config.providers.map(p => String(p.sync.daily.bucket));
    expect(buckets.some(b => b.startsWith('s3://'))).toBe(true);
    expect(buckets.some(b => b.startsWith('gs://'))).toBe(true);
  });

  it('drops ServiceCategory from the GCP dimensions', () => {
    // GCP's FOCUS export has no such column, so the dimension would render one
    // blank value for every row.
    expect(buildDimensionsTemplate('aws')).toContain('service_category');
    expect(buildDimensionsTemplate('gcp')).not.toContain('service_category');
    // SubAccountId is the GCP project — "Account" is the wrong word for it.
    expect(buildDimensionsTemplate('gcp')).toContain('label: Project');
  });

  it('offers the GCP hourly tier commented, since the exporter must opt in', () => {
    const gcp = buildConfigTemplate('gcp');
    expect(gcp).toContain('TIERS=daily,hourly');
    expect(gcp).toContain('#   bucket: gs://your-bucket/focus/hourly/');
    // Live it would fail validation: the exporter publishes nothing there
    // until it is deployed with that tier enabled.
    expect(validateConfig(parse(gcp)).providers[0]?.sync.hourly).toBeUndefined();
  });

  it('leaves no trailing whitespace on the commented block', () => {
    for (const type of TYPES) {
      for (const line of buildConfigTemplate(type).split('\n')) {
        expect(line, JSON.stringify(line)).toBe(line.trimEnd());
      }
    }
  });
});
