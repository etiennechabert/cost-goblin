#!/usr/bin/env bash
# Remove everything deploy.sh created. Idempotent — safe to re-run.
#
# CloudFront is the slow one: a distribution must be disabled and fully
# redeployed before it can be deleted, which takes ~10-15 minutes. Pass
# --skip-cloudfront to leave it alone (it costs nothing while idle) — that
# also preserves the S3 origin bucket, since deleting it would leave the
# surviving distribution serving 403s.
set -uo pipefail   # deliberately no -e: teardown continues past missing resources

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

SKIP_CLOUDFRONT=false
case "${1:-}" in
  "")                 ;;
  --skip-cloudfront)  SKIP_CLOUDFRONT=true ;;
  *) printf 'usage: %s [--skip-cloudfront]\n' "$0" >&2; exit 2 ;;
esac

# Deletes that fail for any reason other than "already gone" are collected and
# reported at the end with a non-zero exit. A teardown script that prints
# "done" while resources keep billing is the one failure mode that matters.
RESIDUAL=()

try() { # $@ = aws command
  local err rc
  err=$("$@" 2>&1 >/dev/null); rc=$?
  (( rc == 0 )) && return 0
  case "$err" in
    *NotFound*|*NoSuchEntity*|*NoSuchBucket*|*ResourceNotFoundException*|\
    *NonExistentQueue*|*EntityNotFound*|*NoSuchDistribution*|*does\ not\ exist*)
      return 0 ;;
  esac
  RESIDUAL+=("${1##*/} ${2:-} ${3:-} — ${err%%$'\n'*}")
  return 1
}

teardown_regional() { # $1=profile $2=region $3=module
  local profile="$1" region="$2" module="$3"
  local r=(--profile "$profile" --region "$region")
  local fn="${PREFIX}-worker" queue_url topic_arn
  log "[${profile}/${region}] removing regional stack"

  try aws events remove-targets "${r[@]}" --rule "${PREFIX}-tick" --ids lambda
  try aws events delete-rule "${r[@]}" --name "${PREFIX}-tick"
  try aws lambda delete-function "${r[@]}" --function-name "$fn"
  try aws cloudwatch delete-alarms "${r[@]}" --alarm-names "${PREFIX}-idle-${module}"
  try aws logs delete-log-group "${r[@]}" --log-group-name "/aws/lambda/${fn}"
  try aws dynamodb delete-table "${r[@]}" --table-name "${PREFIX}-events"

  queue_url=$(aws sqs get-queue-url "${r[@]}" --queue-name "${PREFIX}-work" --query QueueUrl --output text 2>/dev/null)
  [[ -n "$queue_url" && "$queue_url" != "None" ]] && try aws sqs delete-queue "${r[@]}" --queue-url "$queue_url"

  topic_arn=$(aws sns list-topics "${r[@]}" --query "Topics[?ends_with(TopicArn,':${PREFIX}-notify')].TopicArn | [0]" --output text 2>/dev/null)
  [[ -n "$topic_arn" && "$topic_arn" != "None" ]] && try aws sns delete-topic "${r[@]}" --topic-arn "$topic_arn"
  return 0
}

teardown_singletons() { # $1=profile
  local profile="$1" region="$HOME_REGION" sm_arn
  local r=(--profile "$profile" --region "$region")
  log "[${profile}/${region}] removing singletons"

  try aws events remove-targets "${r[@]}" --rule "${PREFIX}-flow-tick" --ids sfn
  try aws events delete-rule "${r[@]}" --name "${PREFIX}-flow-tick"
  sm_arn=$(aws stepfunctions list-state-machines "${r[@]}" \
    --query "stateMachines[?name=='${PREFIX}-flow'].stateMachineArn | [0]" --output text 2>/dev/null)
  [[ -n "$sm_arn" && "$sm_arn" != "None" ]] && try aws stepfunctions delete-state-machine "${r[@]}" --state-machine-arn "$sm_arn"

  try aws events remove-targets "${r[@]}" --rule "${PREFIX}-build-tick" --ids codebuild
  try aws events delete-rule "${r[@]}" --name "${PREFIX}-build-tick"
  try aws codebuild delete-project "${r[@]}" --name "${PREFIX}-build"
  # CodeBuild's log group outlives the project and has no expiry unless named.
  try aws logs delete-log-group "${r[@]}" --log-group-name "/aws/codebuild/${PREFIX}-build"

  try aws glue delete-table "${r[@]}" --database-name "${PREFIX}_catalog" --name lab_events
  try aws glue delete-database "${r[@]}" --name "${PREFIX}_catalog"
  return 0
}

teardown_site() { # $1=profile
  local profile="$1" acct bucket dist_id etag config oac_id oac_etag
  acct=$(account_id "$profile")
  [[ -n "$acct" ]] || { RESIDUAL+=("account id for ${profile} — could not resolve, skipped site teardown"); return 0; }
  bucket="${PREFIX}-site-${acct}"

  # Keep the spike alarm when we keep the distribution it watches — deleting it
  # here (before the --skip-cloudfront return) left a live public distribution
  # with no request-spike monitoring.
  if [[ "$SKIP_CLOUDFRONT" == true ]]; then
    log "leaving CloudFront, its origin bucket, and its spike alarm in place (--skip-cloudfront)"
    return 0
  fi

  try aws cloudwatch delete-alarms --profile "$profile" --region "$CDN_METRIC_REGION" \
    --alarm-names "${PREFIX}-cdn-request-spike"

  dist_id=$(aws cloudfront list-distributions --profile "$profile" \
    --query "DistributionList.Items[?Comment=='${PREFIX}'].Id | [0]" --output text 2>/dev/null)
  if [[ -n "$dist_id" && "$dist_id" != "None" ]]; then
    log "disabling CloudFront ${dist_id} (then ~10-15 min until deletable)"
    etag=$(aws cloudfront get-distribution-config --profile "$profile" --id "$dist_id" \
      --query ETag --output text)
    # --output json is required: this response is piped to jq, and a profile
    # with `output = text` would otherwise silently yield an empty config.
    config=$(aws cloudfront get-distribution-config --profile "$profile" --id "$dist_id" \
      --query DistributionConfig --output json | jq '.Enabled=false')
    if [[ -z "$config" || "$config" == "null" ]]; then
      RESIDUAL+=("cloudfront ${dist_id} — could not read distribution config; not disabled")
    else
      try aws cloudfront update-distribution --profile "$profile" --id "$dist_id" \
        --distribution-config "$config" --if-match "$etag"
      aws cloudfront wait distribution-deployed --profile "$profile" --id "$dist_id" 2>/dev/null
      etag=$(aws cloudfront get-distribution-config --profile "$profile" --id "$dist_id" \
        --query ETag --output text)
      try aws cloudfront delete-distribution --profile "$profile" --id "$dist_id" --if-match "$etag"
    fi

    oac_id=$(aws cloudfront list-origin-access-controls --profile "$profile" \
      --query "OriginAccessControlList.Items[?Name=='${PREFIX}-oac'].Id | [0]" --output text 2>/dev/null)
    if [[ -n "$oac_id" && "$oac_id" != "None" ]]; then
      oac_etag=$(aws cloudfront get-origin-access-control --profile "$profile" --id "$oac_id" --query ETag --output text)
      try aws cloudfront delete-origin-access-control --profile "$profile" --id "$oac_id" --if-match "$oac_etag"
    fi
  fi

  aws s3 rm "s3://${bucket}" --recursive --profile "$profile" --only-show-errors >/dev/null 2>&1
  try aws s3api delete-bucket --profile "$profile" --bucket "$bucket"
  return 0
}

teardown_iam() { # $1=profile
  local profile="$1" role name policy
  for role in "${PREFIX}-lambda:${PREFIX}-worker" "${PREFIX}-sfn:invoke" \
              "${PREFIX}-sfn-events:start" "${PREFIX}-codebuild:logs" "${PREFIX}-build-events:start"; do
    name="${role%%:*}"; policy="${role##*:}"
    try aws iam delete-role-policy --profile "$profile" --role-name "$name" --policy-name "$policy"
    try aws iam delete-role --profile "$profile" --role-name "$name"
  done
  return 0
}

# TARGETS-driven deletion only finds what the CURRENT config describes. Every
# resource carries ManagedBy=cost-goblin-lab, so sweep by tag to catch stacks
# orphaned by a config edit between deploy and teardown.
sweep_strays() {
  local target profile region seen="" key found
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r profile region _ _ <<<"$target"
    key="${profile}|${region}"
    case "$seen" in *"${key};"*) continue ;; esac
    seen="${seen}${key};"
    found=$(aws resourcegroupstaggingapi get-resources --profile "$profile" --region "$region" \
      --tag-filters "Key=ManagedBy,Values=cost-goblin-lab" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null)
    if [[ -n "$found" && "$found" != "None" ]]; then
      local arn
      for arn in $found; do RESIDUAL+=("still tagged cost-goblin-lab: ${arn}"); done
    fi
  done
}

main() {
  local target profile region module env
  resolve_accounts
  log "tearing down CostGoblin free-tier lab"
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r profile region module env <<<"$target"
    teardown_regional "$profile" "$region" "$module"
  done
  teardown_singletons "$MGMT_PROFILE"
  teardown_site "$MGMT_PROFILE"
  teardown_iam "$MGMT_PROFILE"
  [[ "$SANDBOX_PROFILE" != "$MGMT_PROFILE" ]] && teardown_iam "$SANDBOX_PROFILE"
  sweep_strays

  if (( ${#RESIDUAL[@]} > 0 )); then
    warn "teardown finished with ${#RESIDUAL[@]} unresolved item(s):"
    local item
    for item in "${RESIDUAL[@]}"; do warn "  - ${item}"; done
    warn "these may still be billing — resolve them before assuming the lab is gone."
    exit 1
  fi

  log "done. The Organizations member account itself is NOT removed —"
  log "closing an AWS account is a manual, 90-day process in the console."
}

main "$@"
