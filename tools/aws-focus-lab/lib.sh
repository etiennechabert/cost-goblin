#!/usr/bin/env bash
# Shared configuration for the CostGoblin AWS free-tier lab.
# Sourced by deploy.sh and teardown.sh — not meant to run on its own.

PREFIX="cg-lab"
METRIC_NAMESPACE="CostGoblinLab"

# Local, gitignored overrides — this repo is public, so real AWS profile names
# and account IDs live here rather than in tracked files. See config.local.sh.example.
_HERE_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "${_HERE_LIB}/config.local.sh" ]] && source "${_HERE_LIB}/config.local.sh"

# Profile names of the AWS Organizations management account and the member
# account used for the SubAccount dimension. Override via config.local.sh or env.
MGMT_PROFILE="${MGMT_PROFILE:-default}"
SANDBOX_PROFILE="${SANDBOX_PROFILE:-cg-sandbox}"

# The one region that also carries the singletons (Step Functions, CodeBuild,
# CloudFront origin, Glue). Keeping them single-region is what holds Step
# Functions under its 4,000 transitions/month always-free cap.
HOME_REGION="eu-central-1"

# "profile|region|module|environment" — module/environment vary on purpose so
# the FOCUS Tags column has something worth grouping by.
TARGETS=(
  "${MGMT_PROFILE}|eu-central-1|ingest|production"
  "${MGMT_PROFILE}|us-east-1|analytics|development"
  "${MGMT_PROFILE}|eu-west-1|api|staging"
  "${SANDBOX_PROFILE}|eu-central-1|sandbox|sandbox"
)

# Cost allocation tag keys already activated in Billing, so these show up in
# the FOCUS Tags column rather than being silently dropped.
common_tags_cli() { # $1=name $2=module $3=environment  -> "Key=..,Value=.." list
  printf 'Key=Name,Value=%s Key=Module,Value=%s Key=Environment,Value=%s Key=Purpose,Value=CostGoblinFixture Key=ManagedBy,Value=cost-goblin-lab Key=Strategy,Value=free-tier Key=TestFixture,Value=true' \
    "$1" "$2" "$3"
}

# Step Functions and CodeBuild model tags as {key,value}, not {Key,Value}.
common_tags_cli_lower() { # $1=name $2=module $3=environment
  printf 'key=Name,value=%s key=Module,value=%s key=Environment,value=%s key=Purpose,value=CostGoblinFixture key=ManagedBy,value=cost-goblin-lab key=Strategy,value=free-tier key=TestFixture,value=true' \
    "$1" "$2" "$3"
}

common_tags_json() { # $1=name $2=module $3=environment -> [{"Key":..,"Value":..}]
  jq -nc --arg n "$1" --arg m "$2" --arg e "$3" '[
    {Key:"Name",Value:$n},{Key:"Module",Value:$m},{Key:"Environment",Value:$e},
    {Key:"Purpose",Value:"CostGoblinFixture"},{Key:"ManagedBy",Value:"cost-goblin-lab"},
    {Key:"Strategy",Value:"free-tier"},{Key:"TestFixture",Value:"true"}
  ]'
}

common_tags_map() { # $1=name $2=module $3=environment -> {"Key":"Value",...}
  jq -nc --arg n "$1" --arg m "$2" --arg e "$3" '{
    Name:$n, Module:$m, Environment:$e, Purpose:"CostGoblinFixture",
    ManagedBy:"cost-goblin-lab", Strategy:"free-tier", TestFixture:"true"
  }'
}

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }

account_id() { aws sts get-caller-identity --profile "$1" --query Account --output text; }
