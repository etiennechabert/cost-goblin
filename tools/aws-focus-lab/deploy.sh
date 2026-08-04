#!/usr/bin/env bash
# Deploy the CostGoblin AWS free-tier lab. Idempotent — safe to re-run.
#
# Every resource here sits inside an AWS "Always Free" allowance; see
# README.md for the per-service headroom maths. Tear down with ./teardown.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${HERE}/lib.sh"

SITE_URL=""
DIST_ID=""
LAMBDA_ZIP=""

# --------------------------------------------------------------------------
# IAM (global per account)
# --------------------------------------------------------------------------

# Creates the role if absent, then ALWAYS writes the inline policy — PutRolePolicy
# is an idempotent overwrite. Writing it only on the create path would strand a
# role whose first run died between CreateRole and PutRolePolicy, and would make
# every later policy edit a silent no-op.
# $1=profile $2=role $3=service principal $4=policy name $5=policy JSON $6=module $7=env
ensure_role() {
  local profile="$1" role="$2" service="$3" policy_name="$4" policy_doc="$5" module="$6" env="$7"
  local arn created=false

  if ! arn=$(aws iam get-role --profile "$profile" --role-name "$role" \
        --query Role.Arn --output text 2>/dev/null); then
    arn=$(aws iam create-role --profile "$profile" --role-name "$role" \
      --description "CostGoblin free-tier lab" \
      --tags $(common_tags_cli "$role" "$module" "$env") \
      --assume-role-policy-document "$(jq -nc --arg s "$service" \
        '{Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:$s},Action:"sts:AssumeRole"}]}')" \
      --query Role.Arn --output text)
    created=true
  fi

  aws iam put-role-policy --profile "$profile" --role-name "$role" \
    --policy-name "$policy_name" --policy-document "$policy_doc" >/dev/null

  # IAM propagation to consuming control planes is eventually consistent. Only
  # a fresh role needs the wait; callers additionally retry (see await_role).
  [[ "$created" == true ]] && sleep 10
  printf '%s' "$arn"
}

lambda_role_arn() { # $1=profile
  local profile="$1" acct
  acct=$(account_id "$profile")
  # Resource ARNs are pinned to this account (no cross-account wildcard). The
  # two "*" resources below are actions AWS does not support resource-level
  # permissions for; PutMetricData is additionally fenced to our namespace.
  ensure_role "$profile" "${PREFIX}-lambda" lambda.amazonaws.com "${PREFIX}-worker" \
    "$(jq -nc --arg p "$PREFIX" --arg a "$acct" --arg ns "$METRIC_NAMESPACE" '{
      Version:"2012-10-17",
      Statement:[
        {Effect:"Allow",
         Action:["logs:CreateLogStream","logs:PutLogEvents"],
         Resource:("arn:aws:logs:*:"+$a+":log-group:/aws/lambda/"+$p+"-*:*")},
        {Effect:"Allow",Action:["dynamodb:PutItem","dynamodb:GetItem"],
         Resource:("arn:aws:dynamodb:*:"+$a+":table/"+$p+"-*")},
        {Effect:"Allow",Action:["sqs:SendMessage","sqs:ReceiveMessage","sqs:DeleteMessage"],
         Resource:("arn:aws:sqs:*:"+$a+":"+$p+"-*")},
        {Effect:"Allow",Action:["sns:Publish"],
         Resource:("arn:aws:sns:*:"+$a+":"+$p+"-*")},
        {Effect:"Allow",Action:["cloudwatch:PutMetricData"],Resource:"*",
         Condition:{StringEquals:{"cloudwatch:namespace":$ns}}},
        {Effect:"Allow",Action:["xray:PutTraceSegments","xray:PutTelemetryRecords"],Resource:"*"}
      ]}')" platform shared
}

# --------------------------------------------------------------------------
# CloudFront + S3 static origin (singleton, drives the Networking category)
# --------------------------------------------------------------------------

deploy_site() { # $1=profile
  local profile="$1" acct bucket dist_id oac_id domain
  acct=$(account_id "$profile")
  bucket="${PREFIX}-site-${acct}"

  if ! aws s3api head-bucket --profile "$profile" --bucket "$bucket" 2>/dev/null; then
    log "creating origin bucket ${bucket}"
    aws s3api create-bucket --profile "$profile" --bucket "$bucket" \
      --region "$HOME_REGION" --create-bucket-configuration "LocationConstraint=${HOME_REGION}" >/dev/null
    aws s3api put-public-access-block --profile "$profile" --bucket "$bucket" \
      --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
  fi
  aws s3api put-bucket-tagging --profile "$profile" --bucket "$bucket" \
    --tagging "$(jq -nc --argjson t "$(common_tags_json "$bucket" web production)" '{TagSet:$t}')" >/dev/null
  aws s3 cp "${HERE}/site/index.html" "s3://${bucket}/index.html" \
    --profile "$profile" --content-type text/html --only-show-errors

  oac_id=$(aws cloudfront list-origin-access-controls --profile "$profile" \
    --query "OriginAccessControlList.Items[?Name=='${PREFIX}-oac'].Id | [0]" --output text 2>/dev/null || echo "None")
  if [[ "$oac_id" == "None" || -z "$oac_id" ]]; then
    log "creating origin access control"
    oac_id=$(aws cloudfront create-origin-access-control --profile "$profile" \
      --origin-access-control-config "Name=${PREFIX}-oac,Description=CostGoblin lab,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" \
      --query OriginAccessControl.Id --output text)
  fi

  dist_id=$(aws cloudfront list-distributions --profile "$profile" \
    --query "DistributionList.Items[?Comment=='${PREFIX}'].Id | [0]" --output text 2>/dev/null || echo "None")
  if [[ "$dist_id" == "None" || -z "$dist_id" ]]; then
    log "creating CloudFront distribution (deploys in the background, ~5 min)"
    local config
    # CallerReference must be unique per create request, so it carries a
    # timestamp: a deleted distribution's reference cannot be reused.
    config=$(jq -nc --arg b "$bucket" --arg r "$HOME_REGION" --arg oac "$oac_id" \
      --arg p "$PREFIX" --arg ts "$(date -u +%Y%m%d%H%M%S)" '{
      CallerReference: ($p + "-" + $b + "-" + $ts),
      Comment: $p,
      Enabled: true,
      PriceClass: "PriceClass_100",
      DefaultRootObject: "index.html",
      Origins: {Quantity:1, Items:[{
        Id: "s3-origin",
        DomainName: ($b + ".s3." + $r + ".amazonaws.com"),
        OriginAccessControlId: $oac,
        S3OriginConfig: {OriginAccessIdentity: ""}
      }]},
      DefaultCacheBehavior: {
        TargetOriginId: "s3-origin",
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: {Quantity:2, Items:["GET","HEAD"], CachedMethods:{Quantity:2, Items:["GET","HEAD"]}},
        Compress: true,
        CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6"
      }
    }')
    dist_id=$(aws cloudfront create-distribution-with-tags --profile "$profile" \
      --distribution-config-with-tags "$(jq -nc --argjson d "$config" \
        --argjson t "$(common_tags_json "${PREFIX}-cdn" web production)" \
        '{DistributionConfig:$d, Tags:{Items:$t}}')" \
      --query Distribution.Id --output text)
  fi

  # Outside the create branch on purpose: the bucket can be recreated (teardown
  # --skip-cloudfront used to take it) while the distribution survives, and a
  # missing grant means CloudFront 403s on every request with no other symptom.
  aws s3api put-bucket-policy --profile "$profile" --bucket "$bucket" \
    --policy "$(jq -nc --arg b "$bucket" --arg a "$acct" --arg d "$dist_id" '{
      Version:"2012-10-17",
      Statement:[{
        Effect:"Allow",
        Principal:{Service:"cloudfront.amazonaws.com"},
        Action:"s3:GetObject",
        Resource:("arn:aws:s3:::"+$b+"/*"),
        Condition:{StringEquals:{"AWS:SourceArn":("arn:aws:cloudfront::"+$a+":distribution/"+$d)}}
      }]}')" >/dev/null

  domain=$(aws cloudfront get-distribution --profile "$profile" --id "$dist_id" \
    --query Distribution.DomainName --output text)
  SITE_URL="https://${domain}/index.html"
  DIST_ID="$dist_id"
  log "CloudFront origin ready: ${SITE_URL}"
}

# Guard rail: the distribution is the lab's only internet-facing resource, and
# CloudFront's always-free allowance is finite. The lab drives ~48 requests/hour,
# so 5,000 in an hour means something else found it. CloudFront publishes its
# metrics only to us-east-1, hence CDN_METRIC_REGION.
deploy_cdn_alarm() { # $1=profile
  local profile="$1" topic_arn
  [[ -n "$DIST_ID" ]] || fail "no CloudFront distribution id; refusing to leave the CDN unguarded"
  topic_arn=$(aws sns list-topics --profile "$profile" --region "$CDN_METRIC_REGION" \
    --query "Topics[?ends_with(TopicArn,':${PREFIX}-notify')].TopicArn | [0]" --output text)
  [[ -n "$topic_arn" && "$topic_arn" != "None" ]] \
    || fail "no ${PREFIX}-notify topic in ${CDN_METRIC_REGION}; cannot arm the CDN spike alarm"

  aws cloudwatch put-metric-alarm --profile "$profile" --region "$CDN_METRIC_REGION" \
    --alarm-name "${PREFIX}-cdn-request-spike" \
    --alarm-description "cg-lab CloudFront requests far above the lab's own traffic" \
    --namespace AWS/CloudFront --metric-name Requests \
    --dimensions "Name=DistributionId,Value=${DIST_ID}" "Name=Region,Value=Global" \
    --statistic Sum --period 3600 --evaluation-periods 1 \
    --threshold 5000 --comparison-operator GreaterThanThreshold \
    --treat-missing-data notBreaching --alarm-actions "$topic_arn" \
    --tags $(common_tags_cli "${PREFIX}-cdn-request-spike" web production) >/dev/null
  log "CloudFront spike alarm armed (>5000 requests/hour)"
}

# --------------------------------------------------------------------------
# Regional stack: DynamoDB + SQS + SNS + Lambda + EventBridge + CloudWatch
# --------------------------------------------------------------------------

deploy_regional() { # $1=profile $2=region $3=module $4=environment $5=lambda role arn
  local profile="$1" region="$2" module="$3" env="$4" role_arn="$5"
  local r=(--profile "$profile" --region "$region")
  local table="${PREFIX}-events" queue="${PREFIX}-work" topic="${PREFIX}-notify"
  local fn="${PREFIX}-worker" acct queue_url topic_arn fn_arn

  acct=$(account_id "$profile")
  log "[${profile}/${region}] module=${module} env=${env}"

  # DynamoDB — provisioned 1/1 keeps us inside the 25 WCU/25 RCU always-free
  # allowance (on-demand request pricing has no always-free component).
  if ! aws dynamodb describe-table "${r[@]}" --table-name "$table" >/dev/null 2>&1; then
    aws dynamodb create-table "${r[@]}" --table-name "$table" \
      --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
      --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
      --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 \
      --tags $(common_tags_cli "$table" "$module" "$env") >/dev/null
    aws dynamodb wait table-exists "${r[@]}" --table-name "$table"
    aws dynamodb update-time-to-live "${r[@]}" --table-name "$table" \
      --time-to-live-specification "Enabled=true,AttributeName=expires_at" >/dev/null
  fi

  # SQS — SSE-SQS (service-owned key) rather than a KMS CMK, which would cost
  # $1/month and burn the 20k/month free KMS request allowance.
  queue_url=$(aws sqs get-queue-url "${r[@]}" --queue-name "$queue" --query QueueUrl --output text 2>/dev/null || true)
  if [[ -z "$queue_url" ]]; then
    queue_url=$(aws sqs create-queue "${r[@]}" --queue-name "$queue" \
      --attributes "SqsManagedSseEnabled=true,MessageRetentionPeriod=3600" \
      --tags "$(common_tags_kv "$queue" "$module" "$env")" \
      --query QueueUrl --output text)
  fi

  topic_arn=$(aws sns create-topic "${r[@]}" --name "$topic" \
    --tags $(common_tags_cli "$topic" "$module" "$env") --query TopicArn --output text)

  # Log group first, with retention, so Lambda doesn't create a never-expiring one.
  aws logs create-log-group "${r[@]}" --log-group-name "/aws/lambda/${fn}" \
    --tags "$(common_tags_map "$fn" "$module" "$env")" 2>/dev/null || true
  aws logs put-retention-policy "${r[@]}" --log-group-name "/aws/lambda/${fn}" --retention-in-days 7

  local envvars
  envvars=$(jq -nc --arg t "$table" --arg q "$queue_url" --arg s "$topic_arn" \
    --arg m "$module" --arg u "$SITE_URL" --arg n "$METRIC_NAMESPACE" \
    '{Variables:{TABLE_NAME:$t,QUEUE_URL:$q,TOPIC_ARN:$s,MODULE:$m,SITE_URL:$u,METRIC_NAMESPACE:$n}}')

  if aws lambda get-function "${r[@]}" --function-name "$fn" >/dev/null 2>&1; then
    aws lambda update-function-code "${r[@]}" --function-name "$fn" --zip-file "fileb://${LAMBDA_ZIP}" >/dev/null
    aws lambda wait function-updated "${r[@]}" --function-name "$fn"
    # Push the whole configuration, not just the environment: otherwise a
    # runtime bump, a tracing change or a retagging never reaches an existing
    # function, and the stale Module/Environment tags are exactly what FOCUS groups on.
    aws lambda update-function-configuration "${r[@]}" --function-name "$fn" \
      --runtime python3.13 --handler handler.handler --role "$role_arn" \
      --timeout 30 --memory-size 128 --tracing-config Mode=Active \
      --environment "$envvars" >/dev/null
    aws lambda wait function-updated "${r[@]}" --function-name "$fn"
    fn_arn=$(aws lambda get-function "${r[@]}" --function-name "$fn" \
      --query Configuration.FunctionArn --output text)
    aws lambda tag-resource "${r[@]}" --resource "$fn_arn" \
      --tags "$(common_tags_map "$fn" "$module" "$env")" >/dev/null
  else
    fn_arn=$(aws lambda create-function "${r[@]}" --function-name "$fn" \
      --runtime python3.13 --handler handler.handler --role "$role_arn" \
      --zip-file "fileb://${LAMBDA_ZIP}" --timeout 30 --memory-size 128 \
      --tracing-config Mode=Active \
      --environment "$envvars" \
      --tags "$(common_tags_map "$fn" "$module" "$env")" \
      --query FunctionArn --output text)
    # function-active-v2 is the creation waiter; function-updated keys off
    # LastUpdateStatus and returns while a new function is still Pending.
    aws lambda wait function-active-v2 "${r[@]}" --function-name "$fn"
  fi

  # EventBridge schedule. 5 min => ~35k invocations/month across all targets,
  # against the 1M request / 400k GB-s always-free Lambda allowance.
  local rule="${PREFIX}-tick" rule_arn
  rule_arn=$(aws events put-rule "${r[@]}" --name "$rule" \
    --schedule-expression "rate(5 minutes)" --state ENABLED \
    --description "CostGoblin lab heartbeat" \
    --tags $(common_tags_cli "$rule" "$module" "$env") --query RuleArn --output text)
  aws lambda add-permission "${r[@]}" --function-name "$fn" \
    --statement-id "${rule}-invoke" --action lambda:InvokeFunction \
    --principal events.amazonaws.com --source-arn "$rule_arn" >/dev/null 2>&1 || true
  aws events put-targets "${r[@]}" --rule "$rule" \
    --targets "Id=lambda,Arn=${fn_arn}" >/dev/null

  # One alarm per target, plus the CDN alarm — 5 of the 10 always-free alarms.
  # That allowance is shared across the whole organization; see README.
  aws cloudwatch put-metric-alarm "${r[@]}" --alarm-name "${PREFIX}-idle-${module}" \
    --alarm-description "cg-lab worker stopped reporting" \
    --namespace "$METRIC_NAMESPACE" --metric-name WorkItemsProcessed \
    --dimensions "Name=Module,Value=${module}" \
    --statistic Sum --period 3600 --evaluation-periods 1 \
    --threshold 1 --comparison-operator LessThanThreshold \
    --treat-missing-data breaching --alarm-actions "$topic_arn" \
    --tags $(common_tags_cli "${PREFIX}-idle-${module}" "$module" "$env") >/dev/null

  smoke_invoke "$profile" "$region" "$fn"
}

# `aws lambda invoke` exits 0 when the *function* throws — the failure is
# reported as FunctionError in the response body. Without this check the deploy
# reports success against a Lambda that has never once run.
smoke_invoke() { # $1=profile $2=region $3=function
  local profile="$1" region="$2" fn="$3"
  local out="${TMPDIR:-/tmp}/${PREFIX}-invoke.json" resp
  resp=$(aws lambda invoke --profile "$profile" --region "$region" --function-name "$fn" \
    --cli-binary-format raw-in-base64-out --payload '{"source":"deploy"}' "$out")

  if printf '%s' "$resp" | jq -e 'has("FunctionError")' >/dev/null 2>&1; then
    warn "payload: $(cat "$out")"
    fail "[${profile}/${region}] smoke invoke failed: $(printf '%s' "$resp" | jq -r '.FunctionError')"
  fi
  local calls
  calls=$(jq -c '.calls' "$out" 2>/dev/null || echo 'null')
  [[ "$calls" == "null" ]] && fail "[${profile}/${region}] smoke invoke returned no .calls: $(cat "$out")"
  log "[${profile}/${region}] smoke invoke: ${calls}"
}

# --------------------------------------------------------------------------
# Step Functions (singleton — 4,000 transitions/month is the tight one)
# --------------------------------------------------------------------------

deploy_stepfunctions() { # $1=profile
  local profile="$1" region="$HOME_REGION" name="${PREFIX}-flow"
  local r=(--profile "$profile" --region "$region")
  local acct role_arn fn_arn sm_arn events_role_arn

  acct=$(account_id "$profile")
  fn_arn="arn:aws:lambda:${region}:${acct}:function:${PREFIX}-worker"
  aws lambda get-function "${r[@]}" --function-name "${PREFIX}-worker" >/dev/null 2>&1 \
    || fail "${PREFIX}-worker missing in ${region}; the state machine would fail every execution"

  role_arn=$(ensure_role "$profile" "${PREFIX}-sfn" states.amazonaws.com invoke \
    "$(jq -nc --arg f "$fn_arn" \
      '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"lambda:InvokeFunction",Resource:$f}]}')" \
    orchestration production)

  # 4 states; AWS counts transitions as graph nodes including Start and End,
  # so 6 per execution. rate(2 hours) => 12/day * 6 * 30 = 2,160/month of 4,000.
  local definition
  definition=$(jq -nc --arg f "$fn_arn" '{
    Comment:"CostGoblin lab — 6 billable state transitions per execution",
    StartAt:"Collect",
    States:{
      Collect:{Type:"Task",Resource:$f,Next:"Settle"},
      Settle:{Type:"Wait",Seconds:1,Next:"Publish"},
      Publish:{Type:"Task",Resource:$f,Next:"Summarise"},
      Summarise:{Type:"Pass",Result:{status:"ok"},End:true}
    }}')

  sm_arn=$(aws stepfunctions list-state-machines "${r[@]}" \
    --query "stateMachines[?name=='${name}'].stateMachineArn | [0]" --output text)
  if [[ "$sm_arn" == "None" || -z "$sm_arn" ]]; then
    sm_arn=$(aws stepfunctions create-state-machine "${r[@]}" --name "$name" \
      --definition "$definition" --role-arn "$role_arn" --type STANDARD \
      --tags $(common_tags_cli_lower "$name" orchestration production) \
      --query stateMachineArn --output text)
  else
    aws stepfunctions update-state-machine "${r[@]}" --state-machine-arn "$sm_arn" \
      --definition "$definition" --role-arn "$role_arn" >/dev/null
  fi

  events_role_arn=$(ensure_role "$profile" "${PREFIX}-sfn-events" events.amazonaws.com start \
    "$(jq -nc --arg s "$sm_arn" \
      '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"states:StartExecution",Resource:$s}]}')" \
    orchestration production)

  aws events put-rule "${r[@]}" --name "${PREFIX}-flow-tick" \
    --schedule-expression "rate(2 hours)" --state ENABLED \
    --tags $(common_tags_cli "${PREFIX}-flow-tick" orchestration production) >/dev/null
  aws events put-targets "${r[@]}" --rule "${PREFIX}-flow-tick" \
    --targets "Id=sfn,Arn=${sm_arn},RoleArn=${events_role_arn}" >/dev/null
  log "[${profile}/${region}] Step Functions ${name} scheduled every 2h"
}

# --------------------------------------------------------------------------
# CodeBuild (singleton — 100 build minutes/month always free; AWS bills from
# submit to terminate, so queue/provision/finalize count, not just the command)
# --------------------------------------------------------------------------

deploy_codebuild() { # $1=profile
  local profile="$1" region="$HOME_REGION" project="${PREFIX}-build"
  local r=(--profile "$profile" --region "$region")
  local role_arn events_role_arn acct log_group="/aws/codebuild/${PREFIX}-build"
  acct=$(account_id "$profile")

  # Named explicitly with retention, so teardown can find it and it does not
  # accrue indefinitely — CodeBuild otherwise auto-creates one with no expiry.
  aws logs create-log-group "${r[@]}" --log-group-name "$log_group" \
    --tags "$(common_tags_map "$project" build development)" 2>/dev/null || true
  aws logs put-retention-policy "${r[@]}" --log-group-name "$log_group" --retention-in-days 7

  # These log actions do support resource-level permissions, so scope them —
  # CodeBuild is the one component in the lab that executes shell commands.
  role_arn=$(ensure_role "$profile" "${PREFIX}-codebuild" codebuild.amazonaws.com logs \
    "$(jq -nc --arg g "arn:aws:logs:${region}:${acct}:log-group:${log_group}" '{
      Version:"2012-10-17",
      Statement:[{Effect:"Allow",
        Action:["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
        Resource:[$g, ($g+":*")]}]}')" build development)

  local buildspec='version: 0.2
phases:
  build:
    commands:
      - echo "cg-lab synthetic build"'

  local source_cfg artifacts_cfg env_cfg logs_cfg
  source_cfg=$(jq -nc --arg b "$buildspec" '{type:"NO_SOURCE",buildspec:$b}')
  artifacts_cfg='{"type":"NO_ARTIFACTS"}'
  env_cfg='{"type":"LINUX_CONTAINER","image":"aws/codebuild/amazonlinux2-x86_64-standard:5.0","computeType":"BUILD_GENERAL1_SMALL"}'
  logs_cfg=$(jq -nc --arg g "$log_group" '{cloudWatchLogs:{status:"ENABLED",groupName:$g}}')

  if aws codebuild batch-get-projects "${r[@]}" --names "$project" \
      --query 'projects[0].name' --output text 2>/dev/null | grep -q "^${project}$"; then
    aws codebuild update-project "${r[@]}" --name "$project" \
      --source "$source_cfg" --artifacts "$artifacts_cfg" --environment "$env_cfg" \
      --logs-config "$logs_cfg" --service-role "$role_arn" --timeout-in-minutes 5 >/dev/null
  else
    aws codebuild create-project "${r[@]}" --name "$project" \
      --source "$source_cfg" --artifacts "$artifacts_cfg" --environment "$env_cfg" \
      --logs-config "$logs_cfg" --service-role "$role_arn" --timeout-in-minutes 5 \
      --tags $(common_tags_cli_lower "$project" build development) >/dev/null
  fi

  events_role_arn=$(ensure_role "$profile" "${PREFIX}-build-events" events.amazonaws.com start \
    "$(jq -nc --arg p "arn:aws:codebuild:${region}:${acct}:project/${project}" \
      '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"codebuild:StartBuild",Resource:$p}]}')" \
    build development)

  # Daily, ~2 billed minutes per build => ~60 of the 100 free minutes/month.
  # Deploy deliberately does NOT start a build: re-running the script would
  # otherwise burn minutes off an allowance that is already the tightest row.
  aws events put-rule "${r[@]}" --name "${PREFIX}-build-tick" \
    --schedule-expression "rate(1 day)" --state ENABLED \
    --tags $(common_tags_cli "${PREFIX}-build-tick" build development) >/dev/null
  aws events put-targets "${r[@]}" --rule "${PREFIX}-build-tick" \
    --targets "Id=codebuild,Arn=arn:aws:codebuild:${region}:${acct}:project/${project},RoleArn=${events_role_arn}" >/dev/null
  log "[${profile}/${region}] CodeBuild ${project} scheduled daily"
}

# --------------------------------------------------------------------------
# Glue Data Catalog (1M objects + 1M requests always free; no crawler — those
# bill at $0.44/DPU-hour and are not free tier)
# --------------------------------------------------------------------------

deploy_glue() { # $1=profile
  local profile="$1" region="$HOME_REGION" db="${PREFIX}_catalog" acct table_input
  local r=(--profile "$profile" --region "$region")
  acct=$(account_id "$profile")

  aws glue get-database "${r[@]}" --name "$db" >/dev/null 2>&1 || \
    aws glue create-database "${r[@]}" --database-input \
      "$(jq -nc --arg d "$db" '{Name:$d,Description:"CostGoblin free-tier lab catalog"}')" >/dev/null

  # Location must be a bucket we own: an unclaimed name could be registered by
  # someone else and would then be an attacker-controlled table target.
  table_input=$(jq -nc --arg loc "s3://${PREFIX}-site-${acct}/events/" '{
    Name:"lab_events",
    TableType:"EXTERNAL_TABLE",
    Parameters:{classification:"json"},
    StorageDescriptor:{
      Columns:[{Name:"run_id",Type:"string"},{Name:"module",Type:"string"},{Name:"region",Type:"string"}],
      Location:$loc,
      InputFormat:"org.apache.hadoop.mapred.TextInputFormat",
      OutputFormat:"org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
      SerdeInfo:{SerializationLibrary:"org.openx.data.jsonserde.JsonSerDe"}
    }}')
  if aws glue get-table "${r[@]}" --database-name "$db" --name lab_events >/dev/null 2>&1; then
    aws glue update-table "${r[@]}" --database-name "$db" --table-input "$table_input" >/dev/null
  else
    aws glue create-table "${r[@]}" --database-name "$db" --table-input "$table_input" >/dev/null
  fi
  log "[${profile}/${region}] Glue database ${db} ready"
}

# --------------------------------------------------------------------------

main() {
  local target profile region module env mgmt_role sandbox_role role_arn

  validate_targets
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r profile region module env <<<"$target"
    validate_tag_inputs "$region" "$module" "$env"
  done
  resolve_accounts

  log "deploying CostGoblin free-tier lab"

  # Built once: the archive is identical for every target.
  LAMBDA_ZIP="${TMPDIR:-/tmp}/${PREFIX}-lambda.zip"
  (cd "${HERE}/lambda" && rm -f "$LAMBDA_ZIP" && zip -q "$LAMBDA_ZIP" handler.py)

  # The Lambda role is global per account, not per region — resolve one per
  # distinct profile instead of once per target.
  mgmt_role=$(lambda_role_arn "$MGMT_PROFILE")
  if [[ "$SANDBOX_PROFILE" == "$MGMT_PROFILE" ]]; then
    sandbox_role="$mgmt_role"
  else
    sandbox_role=$(lambda_role_arn "$SANDBOX_PROFILE")
  fi

  deploy_site "$MGMT_PROFILE"
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r profile region module env <<<"$target"
    if [[ "$profile" == "$MGMT_PROFILE" ]]; then role_arn="$mgmt_role"; else role_arn="$sandbox_role"; fi
    deploy_regional "$profile" "$region" "$module" "$env" "$role_arn"
  done
  deploy_cdn_alarm "$MGMT_PROFILE"
  deploy_stepfunctions "$MGMT_PROFILE"
  deploy_codebuild "$MGMT_PROFILE"
  deploy_glue "$MGMT_PROFILE"
  log "done — FOCUS line items appear within ~24h of the next export refresh"
}

main "$@"
