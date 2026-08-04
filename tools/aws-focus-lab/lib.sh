#!/usr/bin/env bash
# Shared configuration for the CostGoblin AWS free-tier lab.
# Sourced by deploy.sh and teardown.sh — not meant to run on its own.
# Targets bash 3.2 (macOS system bash): no associative arrays, no `declare -A`.

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

# CloudFront publishes its metrics only to us-east-1, so the CDN guard alarm
# and the SNS topic backing it must live there.
CDN_METRIC_REGION="us-east-1"

# "profile|region|module|environment" — module/environment vary on purpose so
# the FOCUS Tags column has something worth grouping by.
#
# deploy_stepfunctions and deploy_cdn_alarm depend on this array: the former
# needs a stack in MGMT_PROFILE/HOME_REGION, the latter an SNS topic in
# MGMT_PROFILE/CDN_METRIC_REGION. validate_targets() enforces both.
TARGETS=(
  "${MGMT_PROFILE}|eu-central-1|ingest|production"
  "${MGMT_PROFILE}|us-east-1|analytics|development"
  "${MGMT_PROFILE}|eu-west-1|api|staging"
  "${SANDBOX_PROFILE}|eu-central-1|sandbox|sandbox"
)

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
# Tags. One source of truth — the cost allocation tag keys activated in
# Billing, so these reach the FOCUS Tags column instead of being dropped.
# Every other shape is derived, because AWS models tags four different ways.
# --------------------------------------------------------------------------

common_tags_map() { # $1=name $2=module $3=environment -> {"Key":"Value",...}
  jq -nc --arg n "$1" --arg m "$2" --arg e "$3" '{
    Name:$n, Module:$m, Environment:$e, Purpose:"CostGoblinFixture",
    ManagedBy:"cost-goblin-lab", Strategy:"free-tier", TestFixture:"true"
  }'
}

# Deliberately unquoted at call sites so each pair becomes its own argv entry.
# Safe only because every value is [A-Za-z0-9_.-]; validate_tag_inputs() enforces it.
common_tags_cli() { # -> "Key=..,Value=.. Key=..,Value=.."
  common_tags_map "$@" | jq -r 'to_entries|map("Key=\(.key),Value=\(.value)")|join(" ")'
}

# Step Functions and CodeBuild model tags as {key,value}, not {Key,Value}.
common_tags_cli_lower() {
  common_tags_map "$@" | jq -r 'to_entries|map("key=\(.key),value=\(.value)")|join(" ")'
}

common_tags_json() { # -> [{"Key":..,"Value":..}]
  common_tags_map "$@" | jq -c 'to_entries|map({Key:.key,Value:.value})'
}

common_tags_kv() { # -> "K=V,K=V" (sqs create-queue --tags)
  common_tags_map "$@" | jq -r 'to_entries|map("\(.key)=\(.value)")|join(",")'
}

# The unquoted-expansion trick above breaks on whitespace and silently rewrites
# tags on glob characters, so refuse anything that could word-split or expand.
validate_tag_inputs() {
  local v
  for v in "$PREFIX" "$@"; do
    case "$v" in
      *[!A-Za-z0-9_.-]*|"") fail "unsafe tag/name component: '${v}' (allowed: A-Za-z0-9_.-)" ;;
    esac
  done
}

# --------------------------------------------------------------------------
# Account IDs. Resolved once into globals rather than memoized: every call site
# is a command substitution, and a subshell cache would never be seen again.
# --------------------------------------------------------------------------

MGMT_ACCT=""
SANDBOX_ACCT=""

resolve_accounts() {
  MGMT_ACCT=$(aws sts get-caller-identity --profile "$MGMT_PROFILE" --query Account --output text) \
    || fail "cannot resolve account for profile '${MGMT_PROFILE}' — is it authenticated?"
  if [[ "$SANDBOX_PROFILE" == "$MGMT_PROFILE" ]]; then
    SANDBOX_ACCT="$MGMT_ACCT"
  else
    SANDBOX_ACCT=$(aws sts get-caller-identity --profile "$SANDBOX_PROFILE" --query Account --output text) \
      || fail "cannot resolve account for profile '${SANDBOX_PROFILE}' — is it authenticated?"
  fi
}

account_id() { # $1=profile — served from the globals resolve_accounts() filled
  case "$1" in
    "$MGMT_PROFILE")    printf '%s' "$MGMT_ACCT" ;;
    "$SANDBOX_PROFILE") printf '%s' "$SANDBOX_ACCT" ;;
    *) aws sts get-caller-identity --profile "$1" --query Account --output text ;;
  esac
}

# deploy_stepfunctions targets MGMT_PROFILE/HOME_REGION and deploy_cdn_alarm
# needs a topic in MGMT_PROFILE/CDN_METRIC_REGION; both fail confusingly if
# TARGETS is edited so that no stack lands there.
validate_targets() {
  local target profile region has_home=false has_cdn=false
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r profile region _ _ <<<"$target"
    [[ "$profile" == "$MGMT_PROFILE" && "$region" == "$HOME_REGION" ]] && has_home=true
    [[ "$profile" == "$MGMT_PROFILE" && "$region" == "$CDN_METRIC_REGION" ]] && has_cdn=true
  done
  [[ "$has_home" == true ]] || fail "TARGETS needs a ${MGMT_PROFILE}/${HOME_REGION} stack: Step Functions invokes its Lambda"
  [[ "$has_cdn" == true ]] || fail "TARGETS needs a ${MGMT_PROFILE}/${CDN_METRIC_REGION} stack: the CDN alarm needs its SNS topic"
}
