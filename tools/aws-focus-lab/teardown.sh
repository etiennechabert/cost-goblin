#!/usr/bin/env bash
# Remove everything deploy.sh created. Idempotent — safe to re-run.
#
# CloudFront is the slow one: a distribution must be disabled and fully
# redeployed before it can be deleted, which takes ~10-15 minutes. Pass
# --skip-cloudfront to leave it alone (it costs nothing while idle).
set -uo pipefail   # deliberately no -e: teardown continues past missing resources

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

SKIP_CLOUDFRONT=false
[[ "${1:-}" == "--skip-cloudfront" ]] && SKIP_CLOUDFRONT=true

teardown_regional() { # $1=profile $2=region $3=module
  local profile="$1" region="$2" module="$3"
  local r=(--profile "$profile" --region "$region")
  local fn="${PREFIX}-worker" queue_url
  log "[${profile}/${region}] removing regional stack"

  aws events remove-targets "${r[@]}" --rule "${PREFIX}-tick" --ids lambda >/dev/null 2>&1
  aws events delete-rule "${r[@]}" --name "${PREFIX}-tick" >/dev/null 2>&1
  aws lambda delete-function "${r[@]}" --function-name "$fn" >/dev/null 2>&1
  aws cloudwatch delete-alarms "${r[@]}" --alarm-names "${PREFIX}-idle-${module}" >/dev/null 2>&1
  aws logs delete-log-group "${r[@]}" --log-group-name "/aws/lambda/${fn}" >/dev/null 2>&1
  aws dynamodb delete-table "${r[@]}" --table-name "${PREFIX}-events" >/dev/null 2>&1
  queue_url=$(aws sqs get-queue-url "${r[@]}" --queue-name "${PREFIX}-work" --query QueueUrl --output text 2>/dev/null)
  [[ -n "$queue_url" && "$queue_url" != "None" ]] && aws sqs delete-queue "${r[@]}" --queue-url "$queue_url" >/dev/null 2>&1
  local topic_arn
  topic_arn=$(aws sns list-topics "${r[@]}" --query "Topics[?ends_with(TopicArn,':${PREFIX}-notify')].TopicArn | [0]" --output text 2>/dev/null)
  [[ -n "$topic_arn" && "$topic_arn" != "None" ]] && aws sns delete-topic "${r[@]}" --topic-arn "$topic_arn" >/dev/null 2>&1
  return 0
}

teardown_singletons() { # $1=profile
  local profile="$1" region="$HOME_REGION"
  local r=(--profile "$profile" --region "$region")
  log "[${profile}/${region}] removing singletons"

  aws events remove-targets "${r[@]}" --rule "${PREFIX}-flow-tick" --ids sfn >/dev/null 2>&1
  aws events delete-rule "${r[@]}" --name "${PREFIX}-flow-tick" >/dev/null 2>&1
  local sm_arn
  sm_arn=$(aws stepfunctions list-state-machines "${r[@]}" \
    --query "stateMachines[?name=='${PREFIX}-flow'].stateMachineArn | [0]" --output text 2>/dev/null)
  [[ -n "$sm_arn" && "$sm_arn" != "None" ]] && aws stepfunctions delete-state-machine "${r[@]}" --state-machine-arn "$sm_arn" >/dev/null 2>&1

  aws events remove-targets "${r[@]}" --rule "${PREFIX}-build-tick" --ids codebuild >/dev/null 2>&1
  aws events delete-rule "${r[@]}" --name "${PREFIX}-build-tick" >/dev/null 2>&1
  aws codebuild delete-project "${r[@]}" --name "${PREFIX}-build" >/dev/null 2>&1

  aws glue delete-table "${r[@]}" --database-name "${PREFIX}_catalog" --name lab_events >/dev/null 2>&1
  aws glue delete-database "${r[@]}" --name "${PREFIX}_catalog" >/dev/null 2>&1
  return 0
}

teardown_site() { # $1=profile
  local profile="$1" acct bucket dist_id etag config
  acct=$(account_id "$profile")
  bucket="${PREFIX}-site-${acct}"

  aws cloudwatch delete-alarms --profile "$profile" --region us-east-1 \
    --alarm-names "${PREFIX}-cdn-request-spike" >/dev/null 2>&1

  if [[ "$SKIP_CLOUDFRONT" == false ]]; then
    dist_id=$(aws cloudfront list-distributions --profile "$profile" \
      --query "DistributionList.Items[?Comment=='${PREFIX}'].Id | [0]" --output text 2>/dev/null)
    if [[ -n "$dist_id" && "$dist_id" != "None" ]]; then
      log "disabling CloudFront ${dist_id} (then ~10-15 min until deletable)"
      etag=$(aws cloudfront get-distribution-config --profile "$profile" --id "$dist_id" --query ETag --output text)
      config=$(aws cloudfront get-distribution-config --profile "$profile" --id "$dist_id" \
        --query DistributionConfig | jq '.Enabled=false')
      aws cloudfront update-distribution --profile "$profile" --id "$dist_id" \
        --distribution-config "$config" --if-match "$etag" >/dev/null 2>&1
      aws cloudfront wait distribution-deployed --profile "$profile" --id "$dist_id" 2>/dev/null
      etag=$(aws cloudfront get-distribution-config --profile "$profile" --id "$dist_id" --query ETag --output text)
      aws cloudfront delete-distribution --profile "$profile" --id "$dist_id" --if-match "$etag" >/dev/null 2>&1
      local oac_id oac_etag
      oac_id=$(aws cloudfront list-origin-access-controls --profile "$profile" \
        --query "OriginAccessControlList.Items[?Name=='${PREFIX}-oac'].Id | [0]" --output text 2>/dev/null)
      if [[ -n "$oac_id" && "$oac_id" != "None" ]]; then
        oac_etag=$(aws cloudfront get-origin-access-control --profile "$profile" --id "$oac_id" --query ETag --output text)
        aws cloudfront delete-origin-access-control --profile "$profile" --id "$oac_id" --if-match "$oac_etag" >/dev/null 2>&1
      fi
    fi
  fi

  aws s3 rm "s3://${bucket}" --recursive --profile "$profile" --only-show-errors >/dev/null 2>&1
  aws s3api delete-bucket --profile "$profile" --bucket "$bucket" >/dev/null 2>&1
  return 0
}

teardown_iam() { # $1=profile
  local profile="$1" role
  for role in "${PREFIX}-lambda:${PREFIX}-worker" "${PREFIX}-sfn:invoke" \
              "${PREFIX}-sfn-events:start" "${PREFIX}-codebuild:logs" "${PREFIX}-build-events:start"; do
    local name="${role%%:*}" policy="${role##*:}"
    aws iam delete-role-policy --profile "$profile" --role-name "$name" --policy-name "$policy" >/dev/null 2>&1
    aws iam delete-role --profile "$profile" --role-name "$name" >/dev/null 2>&1
  done
  return 0
}

main() {
  log "tearing down CostGoblin free-tier lab"
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r profile region module env <<<"$target"
    teardown_regional "$profile" "$region" "$module"
  done
  teardown_singletons "$MGMT_PROFILE"
  teardown_site "$MGMT_PROFILE"
  teardown_iam "$MGMT_PROFILE"
  teardown_iam "$SANDBOX_PROFILE"
  log "done. The Organizations member account itself is NOT removed —"
  log "closing an AWS account is a manual, 90-day process in the console."
}

main "$@"
