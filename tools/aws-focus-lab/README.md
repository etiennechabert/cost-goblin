# AWS free-tier lab

Synthetic always-free AWS workload whose only job is to make the FOCUS 1.2
export interesting enough to develop CostGoblin against. Before this existed the
export had 4 services, 5 regions, 1 sub-account and **zero populated tags**.

```bash
cp config.local.sh.example config.local.sh   # then fill in your AWS profile names
./deploy.sh                                  # idempotent, safe to re-run
./teardown.sh                                # removes everything (see caveats at the bottom)
```

`config.local.sh` is gitignored. This repo is public, so no AWS account IDs,
profile names or root-account email aliases belong in tracked files — account IDs
in particular make role-name probing and bucket-name guessing easy, since the
origin bucket is named `cg-lab-site-<account-id>`.

Prerequisites: an AWS Organizations **management** account whose FOCUS 1.2 Data
Export CostGoblin already reads, plus a member account reachable via
`OrganizationAccountAccessRole`. Both need `aws` CLI profiles, plus `jq` and `zip`.

## The thing to understand first

**Always-free usage lands in FOCUS with `BilledCost` = `ListCost` = 0.** This is
visible in the pre-existing data:

| ChargeDescription | PricingQuantity | ListCost |
|---|---|---|
| `$0 for AWS Glue Data Catalog requests under the free tier` | 6 | 0 |
| `First 5GB-mo per month of logs storage is free.` | 0 | 0 |

So this lab buys **dimensional** richness — services, regions, resources, meters,
service categories, sub-accounts, tags — not dollars. The cost chart stays flat
near the ~$0.02/month the FOCUS export's own S3 storage already costs. Adding
non-zero spend was a deliberate no (see "Rejected" below).

## What gets created

Four regional stacks, each tagged with a different `Module` / `Environment` pair
so tag grouping has something to show:

| Account | Region | Module | Environment |
|---|---|---|---|
| management (`$MGMT_PROFILE`) | eu-central-1 | ingest | production |
| management | us-east-1 | analytics | development |
| management | eu-west-1 | api | staging |
| member (`$SANDBOX_PROFILE`) | eu-central-1 | sandbox | sandbox |

Each stack: a DynamoDB table, an SQS queue, an SNS topic, a Python 3.13 Lambda
with X-Ray active tracing, an EventBridge `rate(5 minutes)` schedule, a log group
at 7-day retention, and a CloudWatch alarm.

Singletons in eu-central-1 on the management account: a Step Functions Standard
state machine (`rate(2 hours)`), a CodeBuild project (`rate(1 day)`), a Glue
database + table, and an S3-origin CloudFront distribution.

Resulting FOCUS service categories: Compute, Databases, Application Integration,
Management and Governance, Developer Tools, Networking, Analytics, Storage.

## Free-tier headroom

Every allowance below is **Always Free** — none of it is the 12-month tier, which
expired on this account. Percentages are of the monthly cap.

| Service | Allowance | Lab usage | Used |
|---|---|---|---|
| Lambda requests | 1,000,000 | ~34,600 | 3% |
| Lambda compute | 400,000 GB-s | ~8,600 GB-s | 2% |
| DynamoDB capacity | 25 WCU + 25 RCU | 4 WCU + 4 RCU | 16% |
| DynamoDB storage | 25 GB | <1 MB (24h TTL) | ~0% |
| SQS requests | 1,000,000 | ~104,000 | 10% |
| SNS publishes | 1,000,000 | ~34,600 | 3% |
| CloudWatch custom metrics | 10 | 4 | 40% |
| CloudWatch alarms | 10 | 5 | 50% |
| CloudWatch logs ingest | 5 GB | ~14 MB | ~0% |
| **Step Functions transitions** | **4,000** | **~1,800** | **45%** |
| X-Ray traces | 100,000 | ~34,600 | 35% |
| CodeBuild build minutes | 100 | ~30 | 30% |
| CloudFront requests | 1,000,000 | ~34,600 | 3% |
| Glue catalog objects | 1,000,000 | 2 | ~0% |

Step Functions is the binding constraint, which is why the state machine runs in
one region only at `rate(2 hours)` rather than alongside every regional stack.
**If you raise any schedule frequency, re-check that row first.**

The only genuinely non-zero cost is a few hundred bytes of S3 for the CloudFront
origin object — S3's 5 GB allowance is 12-month, not always-free, and has expired
here. It rounds to well under a cent per month.

## Deliberately rejected

| Considered | Why not |
|---|---|
| API Gateway | Its 1M calls is **12-month**, not always-free — would bill on this account |
| Athena | No free tier; $5/TB with a 10 MB minimum per query |
| Customer-managed KMS key | $1/month each, and would burn the 20k/month free KMS requests |
| Glue crawler | $0.44/DPU-hour, no free tier (the Data Catalog itself is free) |
| Route 53 hosted zone | $0.50/month, no free tier |
| Secrets Manager | $0.40/secret/month |
| EC2 / RDS / EFS | 12-month tier only, expired on this account |
| NAT Gateway, EIP, ALB/NLB | Never free |
| ECR Public image | Repo is free but `docker` isn't available here; an empty repo emits no usage lines |

## Security notes

- No inbound surface: no EC2, no security groups, no VPC changes. Lambdas are not
  VPC-attached and make outbound AWS API calls only.
- The origin bucket has all four public-access blocks on; its policy grants
  `s3:GetObject` to `cloudfront.amazonaws.com` alone, fenced by `AWS:SourceArn`
  to the one distribution.
- The Lambda role's resource ARNs are pinned to the deploying account (no
  cross-account wildcard). `cloudwatch:PutMetricData` is conditioned on the
  `CostGoblinLab` namespace.
- SQS uses SSE-SQS (service-owned key), not a KMS CMK.
- The Glue table's `Location` points at a bucket we own. An unclaimed bucket name
  there would be a name-squatting foothold.
- **CloudFront is the only internet-facing resource.** It serves one static HTML
  file with no secrets. `cg-lab-cdn-request-spike` (us-east-1) fires above 5,000
  requests/hour — the lab itself drives ~36/hour.
- **Not handled here:** an Organizations-created member account has no root
  password or MFA set, so its recovery path is whatever email alias it was
  created with. Harden that in the console.

## Teardown caveats

`./teardown.sh` removes every resource. Two things it deliberately does not do:

1. **CloudFront takes ~10-15 minutes** — a distribution must be disabled and fully
   redeployed before deletion. Pass `--skip-cloudfront` to leave it (idle costs
   nothing).
2. **The member account is not closed.** Closing an AWS account is a
   manual console action with a 90-day suspension period.

Activated cost allocation tags are also left alone — they're an account-level
billing setting, not a resource, and deactivating them would lose tag history.
