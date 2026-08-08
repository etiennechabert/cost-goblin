/**
 * Starter `costgoblin.yaml` / `dimensions.yaml` for a workspace with no config
 * yet — written by the `setup:scaffold-config` handler and by the setup
 * wizard's GCP step.
 *
 * Pure string building, kept out of the handler so the generated YAML can be
 * round-tripped through the real validators in a test. A template that fails to
 * parse strands the user on an app that will not start, with no clue which line
 * is wrong.
 */

export type TemplateProviderType = 'aws' | 'gcp';

/** Built-in dimensions a provider's FOCUS export cannot populate — scaffolding
 *  them produces a dimension that renders one blank value for every row. GCP's
 *  export has no ServiceCategory, and the canonicalizer NULL-fills x_Operation
 *  and SkuMeter. Shared by the setup writer (which omits them for a gcp
 *  provider) and the default-dimension merge (which must not resurrect them for
 *  a workspace whose every provider is one that cannot fill them). */
export const PROVIDER_ABSENT_DIMENSIONS: Record<TemplateProviderType, ReadonlySet<string>> = {
  aws: new Set<string>(),
  gcp: new Set(['service_category', 'operation', 'sku_meter']),
};

const AWS_PROVIDER = `  - name: aws-main
    type: aws
    credentialsProfile: default  # <- your AWS CLI profile name
    sync:
      daily:
        bucket: s3://your-bucket/path/to/focus-export/  # <- path containing data/ and metadata/
        retentionDays: 365
      intervalMinutes: 60
`;

const GCP_PROVIDER = `  - name: gcp-main
    type: gcp
    # Bucket the exporter writes to: its BUCKET + PREFIX + the tier folder.
    # Credentials come from Application Default Credentials
    # (gcloud auth application-default login). Add impersonateServiceAccount
    # to run as a read-only service account instead.
    sync:
      daily:
        bucket: gs://your-bucket/focus/daily/
        retentionDays: 365
      # Only if the exporter runs with TIERS=daily,hourly.
      # hourly:
      #   bucket: gs://your-bucket/focus/hourly/
      #   retentionDays: 14
      intervalMinutes: 60
`;

/** Turn a provider block into the commented alternative shown beside the
 *  active one, so adding the second provider is uncommenting rather than
 *  looking up the shape.
 *
 *  The comment marker goes BEFORE the existing indentation, never in place of
 *  it. Trimming first (`# ${line.trimStart()}`) flattens every level to the
 *  same column, so a user who follows the instruction and strips the markers
 *  gets `- name:` and `type:` as siblings — invalid YAML, and an app that will
 *  not start until they work out the indentation themselves.
 *
 *  Blank lines stay blank: a `#` on its own is just trailing whitespace. */
function commented(block: string): string {
  return block
    .split('\n')
    .map(line => (line.trim() === '' ? '' : `# ${line}`))
    .join('\n');
}

export function buildConfigTemplate(providerType: TemplateProviderType): string {
  const forGcp = providerType === 'gcp';
  const active = forGcp ? GCP_PROVIDER : AWS_PROVIDER;
  // The prose sits at column 0 like the commented block below it, so removing
  // every `# ` in the selection leaves valid YAML and nothing half-indented.
  const alternative = forGcp
    ? `# An AWS provider looks like this — uncomment the block below to add one
# alongside the GCP provider above. It reads a FOCUS 1.2 Data Export from S3.
${commented(AWS_PROVIDER)}`
    : `# A GCP provider looks like this — uncomment the block below to add one
# alongside the AWS provider above. It reads the bucket filled by
# scripts/gcp-focus-exporter. There is no costOptimization tier: GCP has no
# analogue.
${commented(GCP_PROVIDER)}`;

  return `# CostGoblin configuration
# See https://github.com/etiennechabert/cost-goblin for documentation

providers:
${active}
${alternative}
defaults:
  periodDays: 30
  costMetric: effective
  # How many trailing days to treat as still settling. GCP's export refreshes
  # several times a day, so it needs less of a margin than AWS.
  lagDays: ${forGcp ? '1' : '2'}
`;
}

export function buildDimensionsTemplate(providerType: TemplateProviderType): string {
  // GCP's FOCUS export has no ServiceCategory column, so that dimension would
  // render a single blank value for every row. SubAccountId is the GCP
  // project, which is what "Account" means on that provider.
  const builtIn = providerType === 'gcp'
    ? `builtIn:
  - name: account
    label: Project
    field: account_id
    displayField: account_name
  - name: region
    label: Region
    field: region
  - name: service
    label: Service
    field: service
`
    : `builtIn:
  - name: account
    label: Account
    field: account_id
    displayField: account_name
  - name: region
    label: Region
    field: region
  - name: service
    label: Service
    field: service
  - name: service_category
    label: Service Category
    field: service_category
`;

  return `# Dimension configuration
# Built-in dimensions are always available. Add tag dimensions to map your
# resource tags (the FOCUS Tags map).

${builtIn}
# Map your resource tags below.
# tagName: the tag key exactly as it appears in the FOCUS Tags map
# concept: owner | product | environment (enables special UI features)
tags: []
  # Example:
  # - tagName: team
  #   label: Team
  #   concept: owner
  # - tagName: app
  #   label: Application
  #   concept: product
  # - tagName: env
  #   label: Environment
  #   concept: environment
`;
}
