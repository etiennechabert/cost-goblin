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

> **These allowances are shared across the whole AWS Organization**, not per
> account — AWS applies the free tier to total usage across all member accounts.
> The two counted-item rows below are the ones that matter: if the org already
> has 6 alarms or 7 custom metrics anywhere, this lab tips them over, at
> $0.10/alarm and $0.30/metric per month. Check before deploying.

Usage figures include both the EventBridge `rate(5 minutes)` invocations
(4 stacks × 288/day) **and** the two Lambda invocations per Step Functions
execution (12/day × 2).

| Service | Allowance | Lab usage | Used |
|---|---|---|---|
| Lambda requests | 1,000,000 | ~35,300 | 4% |
| Lambda compute | 400,000 GB-s | ~7,000–13,500 GB-s | 2–3% |
| DynamoDB capacity | 25 WCU + 25 RCU | 4 WCU + 4 RCU | 16% |
| DynamoDB storage | 25 GB | <1 MB (24h TTL) | ~0% |
| SQS requests | 1,000,000 | ~88,000–105,000 | 9–11% |
| SNS publishes | 1,000,000 | ~35,300 | 4% |
| CloudWatch custom metrics † | 10 | 4 | 40% |
| CloudWatch alarms † | 10 | 5 | 50% |
| CloudWatch logs ingest | 5 GB | ~26 MB | ~1% |
| **CodeBuild build minutes** | **100** | **~60** | **60%** |
| **Step Functions transitions** | **4,000** | **2,160** | **54%** |
| X-Ray traces | 100,000 | ~35,300 | 35% |
| CloudFront requests | 10,000,000 | ~35,300 | ~0.4% |
| CloudFront data out | 1 TB | ~10 MB | ~0% |
| Glue catalog objects | 1,000,000 | 2 | ~0% |

† Org-shared counted items — see the note above.

**CodeBuild is the binding constraint, with Step Functions just behind it.**
AWS bills CodeBuild from build submission to termination, so queueing,
provisioning and finalizing count too — budget ~2 billed minutes for a build
whose only command is an `echo`. That is why `deploy.sh` does **not** start a
build: re-running an "idempotent" script would otherwise eat the tightest
allowance in the table.

Step Functions is next at 54%. AWS counts state transitions as graph nodes
*including Start and End*, so this 4-state machine costs **6 per execution**,
not 4 — which is why the state machine runs in one region at `rate(2 hours)`
rather than alongside every regional stack. At `rate(1 hour)` it would be
4,320/month and start billing.

**If you raise any schedule frequency, re-check the two bold rows first.**

Genuinely non-zero costs, all sub-cent: S3 storage for the CloudFront origin
object, plus S3 **requests** — every deploy re-uploads `index.html` (a billable
PUT) and every CloudFront cache miss is a billable GET. S3 has no always-free
tier and its 12-month allowance has expired here.

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
- The CodeBuild role — the lab's only component that executes shell commands —
  is scoped to its own log group rather than `logs:*` on `*`.
- The Glue table's `Location` points at a bucket we own. An unclaimed bucket name
  there would be a name-squatting foothold.
- **CloudFront is the only internet-facing resource.** It serves one static HTML
  file with no secrets. `cg-lab-cdn-request-spike` (us-east-1) fires above 5,000
  requests/hour — the lab itself drives ~48/hour.
- **Not handled here:** an Organizations-created member account has no root
  password or MFA set, so its recovery path is whatever email alias it was
  created with. Harden that in the console.

## Teardown caveats

`./teardown.sh` removes every resource, then sweeps each account/region for
anything still tagged `ManagedBy=cost-goblin-lab` — that catches stacks orphaned
by editing `TARGETS` between deploy and teardown. Anything unresolved is listed
and the script **exits non-zero**, so a partial teardown can't masquerade as a
clean one.

Two things it deliberately does not do:

1. **CloudFront takes ~10-15 minutes** — a distribution must be disabled and fully
   redeployed before deletion. Pass `--skip-cloudfront` to leave it (idle costs
   nothing). That flag also preserves the S3 origin bucket: deleting the origin
   while the distribution lives would leave it serving 403s.
2. **The member account is not closed.** Closing an AWS account is a
   manual console action with a 90-day suspension period.

Activated cost allocation tags are also left alone — they're an account-level
billing setting, not a resource, and deactivating them would lose tag history.
