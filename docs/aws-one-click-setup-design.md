# AWS One-Click Setup — Design Proposal

> Status: **proposal**, not started. Lets a new user get a correct AWS billing setup (bucket,
> lifecycle rules, FOCUS 1.2 exports, Cost Optimization Hub export) from the setup wizard instead
> of following the manual guide in the README and on costgoblin.com. Phases are ordered and
> independently shippable; each follows the TDD workflow in CLAUDE.md.

## 1. Problem

Getting AWS data into CostGoblin today is a manual checklist: activate cost allocation tags, create
a bucket, add three lifecycle rules, create one or two FOCUS 1.2 Data Exports with exact settings,
optionally a Cost Optimization Hub export, then open a support case for a backfill. Each wrong
setting fails quietly, and the wizard can only catch it after the fact:

| Mistake | What happens | Caught by |
|---------|--------------|-----------|
| CUR 2.0 table instead of FOCUS 1.2 | Nothing syncs | Wizard (manifest columns) |
| File versioning = *Create new data export file* | Nothing syncs | Wizard (#692) |
| CSV instead of Parquet | Nothing syncs | Not caught |
| No lifecycle rules | Bucket grows forever | Not caught |
| Tags not activated | Tag dimensions empty, not backfilled | Not caught |

The goal: from the wizard's *"Don't have an export yet?"* link, a correct setup in a few clicks,
with CostGoblin's provider config filled in automatically.

## 2. What can be automated

Everything except the backfill fits one CloudFormation stack. Shapes below match AWS's own
[Cloud Intelligence Dashboards template](https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-data-collection/blob/main/data-exports/deploy/data-exports-aggregation.yaml),
which provisions the same exports.

| Piece | How | Notes |
|-------|-----|-------|
| Bucket + policy | `AWS::S3::Bucket`, `AWS::S3::BucketPolicy` | `s3:PutObject` for `bcm-data-exports.amazonaws.com`, scoped by `aws:SourceArn` (`arn:aws:bcm-data-exports:*:<account>:export/*`) and `aws:SourceAccount` |
| Lifecycle rules | On the bucket | Per prefix: daily 400 d, hourly 60 d, cost-optimization 100 d (the README's values, derived from each tier's `retentionDays`); noncurrent versions 1 d; incomplete multipart uploads 7 d |
| Daily FOCUS 1.2 export | `AWS::BCMDataExports::Export` | `SELECT <columns> FROM FOCUS_1_2_AWS`, `TIME_GRANULARITY: DAILY`, `Format`/`Compression: PARQUET`, `Overwrite: OVERWRITE_REPORT`, `RefreshCadence: SYNCHRONOUS` |
| Hourly export (optional) | Same, `TIME_GRANULARITY: HOURLY` | Off by default: it's the large one |
| Cost Optimization Hub export (optional) | Same resource, `COST_OPTIMIZATION_RECOMMENDATIONS` with `INCLUDE_ALL_RECOMMENDATIONS: 'TRUE'` | The Hub must be activated first; AWS's template leaves that to the user too |
| Read access for CostGoblin | `AWS::IAM::ManagedPolicy` (output) | `s3:ListBucket` + `s3:GetObject` on the bucket: exactly what SPEC's *Setup Requirements* list. Attached by an admin, or by the user's SSO permission set. Creating it makes the console ask for the IAM acknowledgement |
| Cost allocation tags | Not in the stack | Stays a guided manual step: which tags matter is the user's call |
| Backfill | Support case | See §5 |

Data Exports' SQL is a subset: the query lists its columns explicitly (no `SELECT *`). The native
`AWS::BCMDataExports::Export` resource exists only in us-east-1, so the stack runs there (see §6).

## 3. Decision: a CloudFormation stack, not AWS calls made by the app

**Chosen:** the wizard prepares a CloudFormation stack; a person with admin rights in the account
reviews and creates it in the AWS console.

**Rejected for v1:** CostGoblin calling `bcm-data-exports:CreateExport`, `s3:CreateBucket` and so on
itself. Reasons:

1. **Permissions.** The stack needs write access in the account that owns the billing data,
   usually the management (payer) account. CostGoblin's day-to-day profile only needs
   `s3:ListBucket`/`s3:GetObject`, and many of its users can't create exports. A stack can be
   handed to whoever can, and the app never holds admin credentials.
2. **Review and undo.** The admin sees every resource before creating it. CloudFormation rolls back
   a half-failed create and deletes everything with the stack. Doing that ourselves across half a
   dozen APIs is a lot of error handling to get right.
3. **Reuse.** Teams that manage AWS with Terraform or CDK can lift the same template.
4. **Precedent.** It's how AWS ships the Cloud Intelligence Dashboards setup.

A direct path stays possible later for single-account users who are their own admin, with an
elevated profile picked per action, as the S3 config publish already does (SPEC, *S3 beacon*).

## 4. Wizard flow

1. **Entry.** The welcome step's *"Don't have an export yet?"* link opens a new *Create AWS
   exports* step, next to the existing *"Billing and Cost Management → Data Exports"* link.
2. **Inputs.** Bucket name (default `costgoblin-billing-<account-id>`; the account id comes from
   `sts:GetCallerIdentity`, which needs no permission), hourly export (off), Cost Optimization Hub
   export (off unless the user says the Hub is activated), retention per tier (defaults from
   `DEFAULT_RETENTION_DAYS`).
3. **Hand-off.** Phase 1: the wizard writes the template with those values baked in as parameter
   defaults, saves it where the user chooses, and opens the CloudFormation console's create page in
   us-east-1. The user picks *Upload a template file*, reviews, creates. Phase 4: a prefilled
   quick-create link replaces the upload (§6). Either way, a *Copy instructions* button gives a
   message to send to an admin.
4. **Config.** The S3 paths are known up front (`s3://<bucket>/<prefix>/<export-name>/`), so the
   wizard writes the provider config immediately, without browsing. The Data view shows *"Waiting
   for AWS's first delivery"* until the first `billing_period=` folder appears. AWS's guidance is
   [about 24 hours, up to 72](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/data-exports.html).
5. **Backfill.** Offered once the stack exists (§5).

## 5. Backfill

AWS re-delivers past months on request through a support case: service *Billing*, category
*Other Billing Questions*, naming the export. The Cloud Intelligence Dashboards guide says
[up to 14 months](https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/data-exports.html);
our docs say 12 and should be checked and aligned. The case must come from the account that owns
the export.

- **Default:** the wizard shows the case text, prefilled with the export names, plus a button that
  opens the [Support Center form](https://support.console.aws.amazon.com/support/home#/case/create).
  Works on every support plan.
- **Optional *"File it for me"*:** `support:CreateCase`. The Support API
  [only works on Business, Enterprise On-Ramp and Enterprise support plans](https://docs.aws.amazon.com/awssupport/latest/APIReference/API_CreateCase.html);
  a `SubscriptionRequiredException` falls back to the form. It files a case in the user's name,
  so it always takes an explicit click and shows the exact text first. It needs a profile allowed
  to call it, picked per action like the S3 config publish.

## 6. Template location and hosting

- **Source:** `scripts/aws-exports/costgoblin-exports.yaml`, next to `scripts/gcp-focus-exporter/`.
- **Pinned by tests** (vitest, parsing with the root `js-yaml` devDependency; no `cfn-lint`, which
  would add a Python toolchain):
  - every export is `PARQUET` + `OVERWRITE_REPORT` from the expected table;
  - the FOCUS query's columns include every entry of `REQUIRED_FOCUS_COLUMNS`
    (`packages/desktop/src/main/setup-manifest.ts`), so the template and the wizard's check can't drift;
  - each lifecycle expiry is at least that tier's default `retentionDays`;
  - the read policy grants only `s3:ListBucket`/`s3:GetObject`, on the stack's bucket only.
- **Region:** the stack, and so the bucket, live in us-east-1, where the native export resource
  exists. CostGoblin downloads to a laptop, so the bucket's region barely matters. Another region
  would need a Lambda-backed custom resource calling the us-east-1 API, as AWS's template does.
  Out of scope for v1.
- **Hosting (phase 4):** a quick-create link only accepts a template
  [stored in S3](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-using-console-create-stack-template.html).
  That needs a public-read bucket owned by the project, with `release.yml` uploading the template
  per tag. Today `release.yml` has no AWS credentials and runs only lockfile-pinned code (CLAUDE.md,
  *Dependency supply chain*), so this needs an OIDC role scoped to that one bucket. Phases 1–3
  don't need it.

## 7. Phases

1. **Template, tests, docs.** Ship the template and its invariant tests. The README and the
   costgoblin.com AWS guide offer *"Create it with CloudFormation"* as an alternative to the manual
   steps.
2. **Wizard step.** Inputs, template generation with baked-in defaults, console hand-off, config
   written up front, *"Waiting for first delivery"* state in the Data view.
3. **Backfill helper.** Prefilled case text and Support Center link, then the optional API path.
4. **Hosted quick-create link.** Template bucket, release upload, prefilled link replacing the
   upload step.

## 8. Out of scope / open questions

- **Cross-account delivery** (exports in the payer account, bucket in a separate data-collection
  account): AWS's template supports it. v1 is single-account.
- **Fixing an existing export from the app** (for example switching a *Create new* export to
  Overwrite with `UpdateExport`): same permission concerns as §3. The wizard links to the console
  instead (#692).
- **Open:** who owns the template-hosting bucket and the release OIDC role; default export names
  and S3 prefixes (the README's `focus_daily/`, `focus_hourly/`, `cost_optimization/`); whether
  the Cost Optimization Hub export should default on when the Hub is already activated.
