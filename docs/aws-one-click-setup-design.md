# AWS One-Click Setup — Design Proposal

> Status: **implemented**, phases 1 to 4. Phase 4's hosted quick-create link stays off until the
> maintainer deploys the hosting stack (`scripts/aws-exports/hosting/README.md`); the GCP
> equivalent (§10) is not started; decisions taken since
> drafting are recorded in §9. Lets a new user get a correct AWS billing setup (bucket,
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
| Lifecycle rules | On the bucket | Per prefix (`costgoblin/daily/`, `costgoblin/hourly/`, `costgoblin/cost-optimization/`): 400 d, 60 d, 100 d, each above that tier's default `retentionDays`; noncurrent versions 1 d; incomplete multipart uploads 7 d |
| Daily FOCUS 1.2 export | `AWS::BCMDataExports::Export` | `SELECT <columns> FROM FOCUS_1_2_AWS`, `TIME_GRANULARITY: DAILY`, `Format`/`Compression: PARQUET`, `Overwrite: OVERWRITE_REPORT`, `RefreshCadence: SYNCHRONOUS` |
| Hourly export (optional) | Same, `TIME_GRANULARITY: HOURLY` | Off by default: it's the large one |
| Cost Optimization Hub export (optional, off by default) | Same resource, `COST_OPTIMIZATION_RECOMMENDATIONS` with `INCLUDE_ALL_RECOMMENDATIONS: 'TRUE'` | The Hub must be activated first. The export needs the `AWSServiceRoleForBCMDataExports` service-linked role: the stack creates it unless told the account already has it (AWS's template uses a Lambda for that; we use a parameter). AWS [doesn't offer Overwrite](https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html) for this export, so the wizard never applies #692's check to it (#695) |
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
   a half-failed create, and deleting the stack removes the exports and policies (the bucket and
   its data are kept: `DeletionPolicy: Retain`). Doing that ourselves across half a
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

- **Source:** `packages/core/src/aws-setup/exports-stack.ts` builds the template as data, with
  long-form intrinsics (`{ Ref: … }`), so tests can inspect it and the wizard can bake in its
  answers. `scripts/aws-exports/write-template.ts` writes the committed
  `scripts/aws-exports/costgoblin-exports.yaml`, and a drift test fails if they differ. The YAML
  is emitted under YAML 1.1 rules, which quote `yes`/`no` and date-like versions that 1.1 would
  otherwise read as booleans and timestamps.
- **Pinned by tests** (`packages/core/src/__tests__/aws-exports-stack.test.ts`). `cfn-lint` adds
  a Python toolchain, so it isn't in CI; it was run once by hand (1.57.1, clean):
  - every export is `PARQUET` + `OVERWRITE_REPORT` from the expected table;
  - the FOCUS query's columns include every entry of core's `REQUIRED_FOCUS_COLUMNS`, so the
    template and the wizard's check can't drift;
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
  don't need it. As built: `scripts/aws-exports/hosting/template-hosting.yaml` creates the bucket
  (only `templates/` public), GitHub's OIDC provider and `ReleaseUploadRole`, which trusts only the
  repository's `release` environment (which must keep its required reviewer and ref limits, today `main` and `v*` tags, or any branch declaring it could replace the public template) and can only write under `templates/`. `release.yml`'s
  `publish-template` job holds only `id-token: write`, runs no npm code, uploads the committed
  template to `templates/<tag>/` and `templates/latest/`, and is skipped until the
  `TEMPLATE_BUCKET`, `TEMPLATE_ROLE_ARN` and `TEMPLATE_REGION` variables are set. The hosting
  bucket can live in any region (the maintainer's is in eu-central-1): only the users' exports
  stack has to be in us-east-1. The app asks the main process for
  the template matching its build (a release's own tag, `latest` for a development build) and
  offers the link only when `HOSTED_EXPORTS_TEMPLATE_BASE_URL` is set.

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
- **Open:** who owns the template-hosting bucket and the release OIDC role (phase 4). Resolved:
  a member account of the maintainer's Organization, in eu-central-1.
- **Open:** a users' billing bucket outside us-east-1, e.g. in Europe. The exports stack has to
  run in us-east-1, and so does the bucket it creates. A two-stack variant would lift that: a
  bucket stack in any region, and the exports stack in us-east-1 delivering to it through the
  export's `S3Region`.
- **Open:** whether CostGoblin reads a real Cost Optimization Hub Data Export. Its cost-optimization
  tier only reads Parquet directly in `date=YYYY-MM-DD/`; AWS documents that this export writes
  every refresh to its own directory, without saying whether that directory is the `date=` folder
  or one below it. AWS's own template partitions the table by `date`, which fits. A key listing
  from a real export settles it.

## 9. Decisions since drafting

- **S3 layout:** everything under `costgoblin/` (`costgoblin/daily`, `costgoblin/hourly`,
  `costgoblin/cost-optimization`), with exports named `costgoblin-daily` and so on. Clearer than the
  README's old `focus_daily/` layout; the manual guide moved to the same prefixes so both paths
  match. Existing setups are unaffected: paths are configurable.
- **Cost Optimization Hub export:** off by default; the user ticks it once the Hub is activated.
- **Bucket name:** empty by default, in which case the stack names it
  `costgoblin-billing-<account id>`, so the manual upload needs no typing. The wizard passes a
  name so it can write the config up front.
- **Scope:** all four phases, with phase 4's hosting infrastructure provided as a template for the
  maintainer to deploy.

## 10. GCP equivalent (phase 5)

The exporter's `deploy.sh` already builds, deploys and schedules the job from one *Open in Cloud
Shell* click. What remains:

- **Turning on the FOCUS BigQuery export stays manual.** Google has
  [no API, gcloud command or Terraform resource for it](https://discuss.google.dev/t/api-to-programmatically-manage-cloud-billing-export-enable-or-disable/302037).
  The wizard links to it and says to do it first: it only backfills the current and previous month.
- **Fold the other manual steps into the script,** as opt-in flags: create the bucket in the
  dataset's location with its lifecycle rules, and the read-only `costgoblin-reader` account with
  its bindings.
- **Same wizard pattern:** project, bucket and reader in, a prefilled one-line command for Cloud
  Shell out (its links can open the repo but can't carry values), the GCP provider config written
  up front, *"Waiting for the first export run"*.
- **No backfill helper:** there is no support-case route on GCP.
