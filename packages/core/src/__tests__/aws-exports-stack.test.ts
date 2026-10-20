import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  buildExportsStackTemplate,
  EXPORTS_STACK_EXPIRY_DAYS,
  EXPORTS_STACK_LAYOUT,
  EXPORTS_STACK_PARAMETERS,
  exportsStackPath,
  isValidS3BucketName,
  parseExportsStackDefaults,
  renderExportsStackYaml,
} from '../aws-setup/index.js';
import type { TemplateObject, TemplateValue } from '../aws-setup/index.js';
import { REQUIRED_FOCUS_COLUMNS } from '../sync/focus-contract.js';
import { DEFAULT_RETENTION_DAYS } from '../sync/retention.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const COMMITTED_TEMPLATE = join(repoRoot, 'scripts', 'aws-exports', 'costgoblin-exports.yaml');

function isObject(value: TemplateValue | undefined): value is TemplateObject {
  return typeof value === 'object' && !Array.isArray(value);
}

function section(template: TemplateObject, name: string): TemplateObject {
  const value = template[name];
  if (!isObject(value)) throw new Error(`template has no ${name} section`);
  return value;
}

function at(value: TemplateValue | undefined, ...path: string[]): TemplateValue | undefined {
  let current = value;
  for (const key of path) current = isObject(current) ? current[key] : undefined;
  return current;
}

const template = buildExportsStackTemplate();
const resources = section(template, 'Resources');
const exportsByType = (type: string): TemplateObject[] =>
  Object.values(resources).filter((r): r is TemplateObject => isObject(r) && r['Type'] === type);
const dataExports = exportsByType('AWS::BCMDataExports::Export').map(r => at(r, 'Properties', 'Export'));

function selectedColumns(exportDefinition: TemplateValue | undefined): string[] {
  const query = at(exportDefinition, 'DataQuery', 'QueryStatement');
  if (typeof query !== 'string') throw new Error('export without a query');
  const match = /^SELECT (.+) FROM (\w+)$/.exec(query);
  if (match?.[1] === undefined) throw new Error(`unexpected query: ${query}`);
  return match[1].split(', ');
}

function exportNamed(name: string): TemplateValue | undefined {
  return dataExports.find(e => at(e, 'Name') === name);
}

describe('the exports stack template', () => {
  it('delivers every export as Parquet, in place, refreshed by AWS', () => {
    expect(dataExports).toHaveLength(3);
    for (const definition of dataExports) {
      expect(at(definition, 'DestinationConfigurations', 'S3Destination', 'S3OutputConfigurations')).toEqual({
        OutputType: 'CUSTOM', Format: 'PARQUET', Compression: 'PARQUET', Overwrite: 'OVERWRITE_REPORT',
      });
      expect(at(definition, 'RefreshCadence')).toEqual({ Frequency: 'SYNCHRONOUS' });
    }
  });

  it.each([
    ['daily', 'DAILY'],
    ['hourly', 'HOURLY'],
  ] as const)('exports %s FOCUS 1.2 with every column CostGoblin requires', (tier, granularity) => {
    const definition = exportNamed(EXPORTS_STACK_LAYOUT[tier].exportName);
    expect(at(definition, 'DataQuery', 'QueryStatement')).toMatch(/ FROM FOCUS_1_2_AWS$/);
    expect(at(definition, 'DataQuery', 'TableConfigurations')).toEqual({ FOCUS_1_2_AWS: { TIME_GRANULARITY: granularity } });
    expect(selectedColumns(definition)).toEqual(expect.arrayContaining(REQUIRED_FOCUS_COLUMNS));
  });

  it('exports the recommendation columns the wizard recognises a Cost Optimization export by', () => {
    const definition = exportNamed(EXPORTS_STACK_LAYOUT.costOptimization.exportName);
    expect(at(definition, 'DataQuery', 'QueryStatement')).toMatch(/ FROM COST_OPTIMIZATION_RECOMMENDATIONS$/);
    expect(selectedColumns(definition)).toEqual(expect.arrayContaining(['recommendation_id', 'estimated_monthly_savings_after_discount']));
  });

  it('puts each export under its layout prefix, with a lifecycle rule on that prefix', () => {
    const rules = at(resources, 'Bucket', 'Properties', 'LifecycleConfiguration', 'Rules');
    if (!Array.isArray(rules)) throw new Error('no lifecycle rules');
    for (const { exportName, prefix } of Object.values(EXPORTS_STACK_LAYOUT)) {
      expect(at(exportNamed(exportName), 'DestinationConfigurations', 'S3Destination', 'S3Prefix')).toBe(prefix);
      expect(rules).toContainEqual(expect.objectContaining({ Prefix: `${prefix}/`, Status: 'Enabled' }));
    }
  });

  it("never expires a tier's files before its default retention", () => {
    const parameters = section(template, 'Parameters');
    for (const tier of ['daily', 'hourly', 'costOptimization'] as const) {
      expect(EXPORTS_STACK_EXPIRY_DAYS[tier].minimum).toBe(DEFAULT_RETENTION_DAYS[tier]);
      expect(EXPORTS_STACK_EXPIRY_DAYS[tier].default).toBeGreaterThan(DEFAULT_RETENTION_DAYS[tier]);
    }
    expect(at(parameters, EXPORTS_STACK_PARAMETERS.dailyExpirationDays, 'MinValue')).toBe(DEFAULT_RETENTION_DAYS.daily);
    expect(at(parameters, EXPORTS_STACK_PARAMETERS.hourlyExpirationDays, 'MinValue')).toBe(DEFAULT_RETENTION_DAYS.hourly);
    expect(at(parameters, EXPORTS_STACK_PARAMETERS.costOptimizationExpirationDays, 'MinValue')).toBe(DEFAULT_RETENTION_DAYS.costOptimization);
  });

  it('grants CostGoblin only list and read on its own bucket', () => {
    expect(at(resources, 'ReadAccessPolicy', 'Properties', 'PolicyDocument', 'Statement')).toEqual([
      { Effect: 'Allow', Action: 's3:ListBucket', Resource: { 'Fn::Sub': '${Bucket.Arn}' } },
      { Effect: 'Allow', Action: 's3:GetObject', Resource: { 'Fn::Sub': '${Bucket.Arn}/*' } },
    ]);
  });

  it('lets only Data Exports, from this account, write to the bucket', () => {
    const statements = at(resources, 'BucketPolicy', 'Properties', 'PolicyDocument', 'Statement');
    expect(statements).toContainEqual(expect.objectContaining({
      Effect: 'Allow',
      Principal: { Service: 'bcm-data-exports.amazonaws.com' },
      Action: 's3:PutObject',
      Condition: expect.objectContaining({ StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } }),
    }));
    expect(at(resources, 'Bucket', 'Properties', 'PublicAccessBlockConfiguration')).toEqual({
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
  });

  it('keeps the billing data when the stack is deleted', () => {
    expect(at(resources, 'Bucket', 'DeletionPolicy')).toBe('Retain');
    expect(at(resources, 'Bucket', 'UpdateReplacePolicy')).toBe('Retain');
  });

  it("keeps the account's Data Exports service role, which other exports may use, when the stack is deleted", () => {
    expect(at(resources, 'DataExportsServiceRole', 'DeletionPolicy')).toBe('Retain');
    expect(at(resources, 'DataExportsServiceRole', 'UpdateReplacePolicy')).toBe('Retain');
  });

  it('refuses to run outside us-east-1, where Data Exports lives', () => {
    expect(at(section(template, 'Rules'), 'RunsInUsEast1', 'Assertions')).toEqual([
      expect.objectContaining({ Assert: { 'Fn::Equals': [{ Ref: 'AWS::Region' }, 'us-east-1'] } }),
    ]);
  });

  // AWS allows two FOCUS 1.2 exports per account, so an account that already
  // has them can still use the stack for the exports it lacks.
  it('creates each export only when asked, the daily one by default', () => {
    const parameters = section(template, 'Parameters');
    expect(at(parameters, EXPORTS_STACK_PARAMETERS.daily, 'Default')).toBe('yes');
    expect(at(parameters, EXPORTS_STACK_PARAMETERS.daily, 'AllowedValues')).toEqual(['no', 'yes']);
    expect(at(section(template, 'Conditions'), 'WantsDaily')).toEqual({ 'Fn::Equals': [{ Ref: EXPORTS_STACK_PARAMETERS.daily }, 'yes'] });
    expect(at(resources, 'DailyFocusExport', 'Condition')).toBe('WantsDaily');
    expect(at(resources, 'HourlyFocusExport', 'Condition')).toBe('WantsHourly');
    expect(at(resources, 'CostOptimizationExport', 'Condition')).toBe('WantsCostOptimization');
    expect(at(section(template, 'Outputs'), 'DailyExportPath', 'Condition')).toBe('WantsDaily');
  });

  it('refuses a stack that creates no export', () => {
    const wants = (parameter: string): TemplateObject => ({ 'Fn::Equals': [{ Ref: parameter }, 'yes'] });
    expect(at(section(template, 'Rules'), 'CreatesAnExport', 'Assertions')).toEqual([
      expect.objectContaining({
        Assert: { 'Fn::Or': [
          wants(EXPORTS_STACK_PARAMETERS.daily), wants(EXPORTS_STACK_PARAMETERS.hourly), wants(EXPORTS_STACK_PARAMETERS.costOptimization),
        ] },
      }),
    ]);
  });

  it('shows every parameter in a group of the console form', () => {
    const groups = at(template, 'Metadata', 'AWS::CloudFormation::Interface', 'ParameterGroups');
    const grouped = Array.isArray(groups) ? groups.flatMap(group => {
      const names = at(group, 'Parameters');
      return Array.isArray(names) ? names : [];
    }) : [];
    const defined = Object.keys(section(template, 'Parameters'));
    expect(grouped).toHaveLength(defined.length);
    expect(new Set(grouped)).toEqual(new Set(defined));
  });

  it('only references parameters, resources and conditions it defines', () => {
    const parameters = Object.keys(section(template, 'Parameters'));
    const resourceIds = Object.keys(resources);
    const conditions = Object.keys(section(template, 'Conditions'));
    const refs: string[] = [];
    const conditionRefs: string[] = [];
    const walk = (value: TemplateValue | undefined): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!isObject(value)) return;
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'Ref' && typeof inner === 'string') refs.push(inner);
        if (key === 'Condition' && typeof inner === 'string') conditionRefs.push(inner);
        if (key === 'Fn::If' && Array.isArray(inner) && typeof inner[0] === 'string') conditionRefs.push(inner[0]);
        if (key === 'DependsOn' && typeof inner === 'string') refs.push(inner);
        walk(inner);
      }
    };
    walk(template);
    const known = new Set([...parameters, ...resourceIds, 'AWS::Region', 'AWS::AccountId', 'AWS::Partition', 'AWS::NoValue']);
    expect(refs.filter(r => !known.has(r))).toEqual([]);
    expect(conditionRefs.filter(c => !conditions.includes(c))).toEqual([]);
  });

  it("bakes the wizard's answers in as parameter defaults", () => {
    const baked = section(buildExportsStackTemplate({ bucketName: 'acme-billing', hourly: true, costOptimization: true, serviceRole: false }), 'Parameters');
    expect(at(baked, EXPORTS_STACK_PARAMETERS.bucketName, 'Default')).toBe('acme-billing');
    expect(at(baked, EXPORTS_STACK_PARAMETERS.hourly, 'Default')).toBe('yes');
    expect(at(baked, EXPORTS_STACK_PARAMETERS.costOptimization, 'Default')).toBe('yes');
    expect(at(baked, EXPORTS_STACK_PARAMETERS.serviceRole, 'Default')).toBe('no');
    const plain = section(template, 'Parameters');
    expect(at(plain, EXPORTS_STACK_PARAMETERS.bucketName, 'Default')).toBe('');
    expect(at(plain, EXPORTS_STACK_PARAMETERS.hourly, 'Default')).toBe('no');
    expect(at(plain, EXPORTS_STACK_PARAMETERS.costOptimization, 'Default')).toBe('no');
  });

  it('says where to enable Cost Optimization Hub, which the export needs', () => {
    const description = at(section(template, 'Parameters'), EXPORTS_STACK_PARAMETERS.costOptimization, 'Description');
    expect(description).toMatch(/Cost Management preferences, Cost Optimization Hub tab/);
    expect(description).toMatch(/Enable Cost Optimization Hub/);
    expect(description).toMatch(/Save preferences/);
  });

  it("gives the path CostGoblin's config needs for each tier: the export's own folder", () => {
    expect(exportsStackPath('acme-billing', 'daily')).toBe('s3://acme-billing/costgoblin/daily/costgoblin-daily/');
    expect(exportsStackPath('acme-billing', 'hourly')).toBe('s3://acme-billing/costgoblin/hourly/costgoblin-hourly/');
    expect(exportsStackPath('acme-billing', 'costOptimization'))
      .toBe('s3://acme-billing/costgoblin/cost-optimization/costgoblin-cost-optimization/');
  });
});

describe('isValidS3BucketName', () => {
  it.each(['costgoblin-billing-k3x9q2', 'acme.billing', 'abc', 'a'.repeat(63)])('accepts %s', (name) => {
    expect(isValidS3BucketName(name)).toBe(true);
  });

  it.each([
    'ab', 'a'.repeat(64), 'Acme-billing', 'acme_billing', '-acme', 'acme-', 'acme..billing', '192.168.1.1', '',
    // names S3 reserves
    'xn--acme', 'sthree-acme', 'amzn-s3-demo-acme', 'acme-s3alias', 'acme--ol-s3', 'acme.mrap', 'acme--x-s3', 'acme--table-s3',
  ])('rejects %s', (name) => {
    expect(isValidS3BucketName(name)).toBe(false);
  });
});

describe('parseExportsStackDefaults', () => {
  it('accepts the answers the wizard sends', () => {
    expect(parseExportsStackDefaults({ bucketName: 'acme-billing', hourly: true, costOptimization: false, serviceRole: true }))
      .toEqual({ bucketName: 'acme-billing', hourly: true, costOptimization: false, serviceRole: true });
    expect(parseExportsStackDefaults({})).toEqual({});
  });

  it.each([
    ['a non-object', 'acme'],
    ['an invalid bucket name', { bucketName: 'Acme Billing' }],
    ['a bucket name that is not a string', { bucketName: 42 }],
    ['a flag that is not a boolean', { hourly: 'yes' }],
    ['an unknown key', { bucketName: 'acme-billing', region: 'eu-west-1' }],
  ])('refuses %s', (_label, payload) => {
    expect(parseExportsStackDefaults(payload)).toBeNull();
  });
});

describe('the committed template', () => {
  it('is exactly what the generator writes (run scripts/aws-exports/write-template.ts)', () => {
    expect(readFileSync(COMMITTED_TEMPLATE, 'utf8')).toBe(renderExportsStackYaml());
  });

  it('parses back to the template under YAML 1.1 rules, where a bare yes or no is a boolean', () => {
    expect(parse(renderExportsStackYaml(), { version: '1.1' })).toEqual(template);
    expect(parse(renderExportsStackYaml({ hourly: true }), { version: '1.1' })).toEqual(buildExportsStackTemplate({ hourly: true }));
  });
});
