# Hosting the one-click AWS setup's template

The setup wizard can open CloudFormation's quick-create page with the user's answers filled in, instead of saving the template for them to upload. CloudFormation only takes a quick-create template [stored in S3](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-using-console-create-stack-template.html), so each release uploads `scripts/aws-exports/costgoblin-exports.yaml` to a public bucket. This is phase 4 of [the design](../../../docs/aws-one-click-setup-design.md).

It stays off until the steps below are done: the wizard offers save-and-upload, and `release.yml`'s `publish-template` job is skipped until its three repository variables are set.

## Turning it on

1. **Deploy the hosting stack** once, in the AWS account that should host the templates. Any region works; users still create the exports stack in us-east-1, where Data Exports lives, and its console reads the template across regions:

   ```bash
   aws cloudformation deploy --region eu-central-1 --stack-name costgoblin-template-hosting --template-file scripts/aws-exports/hosting/template-hosting.yaml --capabilities CAPABILITY_IAM --parameter-overrides BucketName=<a globally unique bucket name>
   ```

   Add `CreateGitHubOidcProvider=no` if the account already has the `token.actions.githubusercontent.com` OIDC provider. If the account blocks public access at the account level, allow it for this bucket: its `templates/` folder must be publicly readable, as users' consoles fetch the template from there.

2. **Keep the `release` environment protected**, under GitHub → Settings → Environments → `release`: a required reviewer, and deployment branches and tags limited to protected refs. As set up today it already is: you approve every job, and only `main` and `v*` tags may deploy. The upload role trusts any job that runs in that environment, so without these protections a workflow on any branch that declares `environment: release` could replace the public template users' consoles load.

   Then **set the repository variables** from the stack's outputs, under GitHub → Settings → Secrets and variables → Actions → Variables. They are identifiers, not secrets: no AWS key is stored anywhere, as the job exchanges GitHub's per-run OIDC token for 15-minute credentials:

   | Variable | Output |
   |---|---|
   | `TEMPLATE_BUCKET` | `TemplateBucket` |
   | `TEMPLATE_ROLE_ARN` | `ReleaseRoleArn` |
   | `TEMPLATE_REGION` | `TemplateRegion` |

3. **Point the app at it**: set `HOSTED_EXPORTS_TEMPLATE_BASE_URL` in `packages/core/src/aws-setup/hosting.ts` to the `TemplateBaseUrl` output, in a pull request.

The next release tag then uploads `templates/<tag>/costgoblin-exports.yaml`, which that release links to, and `templates/latest/costgoblin-exports.yaml`, which development builds link to.

## What the release job can do

`publish-template` runs in the `release` environment with only `id-token: write`. It exchanges GitHub's OIDC token for 15-minute credentials of `ReleaseUploadRole`, which trusts only this repository's `release` environment and can only write under `templates/` in this bucket. It runs no npm code: it uploads the committed template, which a test keeps identical to its generator. `scripts/ci/workflow-policy.test.mjs` pins all of this.
