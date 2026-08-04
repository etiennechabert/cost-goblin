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

# --------------------------------------------------------------------------
# IAM (global per account)
# --------------------------------------------------------------------------

ensure_lambda_role() { # $1=profile
  local profile="$1" role="${PREFIX}-lambda" arn acct
  if arn=$(aws iam get-role --profile "$profile" --role-name "$role" \
        --query Role.Arn --output text 2>/dev/null); then
    printf '%s' "$arn"; return
  fi
  acct=$(account_id "$profile")
  arn=$(aws iam create-role --profile "$profile" --role-name "$role" \
    --description "CostGoblin free-tier lab worker" \
    --tags $(common_tags_cli "$role" platform shared) \
    --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
    }' --query Role.Arn --output text)

  # Resource ARNs are pinned to this account (no cross-account wildcard). The
  # three "*" resources below are actions AWS does not support resource-level
  # permissions for; PutMetricData is additionally fenced to our namespace.
  aws iam put-role-policy --profile "$profile" --role-name "$role" \
    --policy-name "${PREFIX}-worker" --policy-document "$(jq -nc \
      --arg p "$PREFIX" --arg a "$acct" --arg ns "$METRIC_NAMESPACE" '{
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
      ]}')"

  # IAM propagation to the Lambda control plane is eventually consistent.
  sleep 10
  printf '%s' "$arn"
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
    config=$(jq -nc --arg b "$bucket" --arg r "$HOME_REGION" --arg oac "$oac_id" --arg p "$PREFIX" '{
      CallerReference: ($p + "-" + $b),
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
  fi

  domain=$(aws cloudfront get-distribution --profile "$profile" --id "$dist_id" \
    --query Distribution.DomainName --output text)
  SITE_URL="https://${domain}/index.html"
  DIST_ID="$dist_id"
  log "CloudFront origin ready: ${SITE_URL}"
}

# Guard rail: the distribution is the lab's only internet-facing resource, and
# the CloudFront free plan covers 100 GB / 1M requests per month. The lab itself
# drives ~36 requests/hour, so 5,000 in an hour means something else found it.
# CloudFront metrics are only published to us-east-1.
deploy_cdn_alarm() { # $1=profile
  local profile="$1" topic_arn
  [[ -z "$DIST_ID" ]] && { warn "no distribution id; skipping CDN alarm"; return 0; }
  topic_arn=$(aws sns list-topics --profile "$profile" --region us-east-1 \
    --query "Topics[?ends_with(TopicArn,':${PREFIX}-notify')].TopicArn | [0]" --output text)
  [[ -z "$topic_arn" || "$topic_arn" == "None" ]] && { warn "no us-east-1 topic; skipping CDN alarm"; return 0; }

  aws cloudwatch put-metric-alarm --profile "$profile" --region us-east-1 \
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

deploy_regional() { # $1=profile $2=region $3=module $4=environment
  local profile="$1" region="$2" module="$3" env="$4"
  local r=(--profile "$profile" --region "$region")
  local table="${PREFIX}-events" queue="${PREFIX}-work" topic="${PREFIX}-notify"
  local fn="${PREFIX}-worker" acct role_arn queue_url topic_arn

  acct=$(account_id "$profile")
  role_arn=$(ensure_lambda_role "$profile")
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
      --tags "$(common_tags_map "$queue" "$module" "$env" | jq -r 'to_entries|map("\(.key)=\(.value)")|join(",")')" \
      --query QueueUrl --output text)
  fi

  topic_arn=$(aws sns create-topic "${r[@]}" --name "$topic" \
    --tags $(common_tags_cli "$topic" "$module" "$env") --query TopicArn --output text)

  # Log group first, with retention, so Lambda doesn't create a never-expiring one.
  aws logs create-log-group "${r[@]}" --log-group-name "/aws/lambda/${fn}" \
    --tags "$(common_tags_map "$fn" "$module" "$env")" 2>/dev/null || true
  aws logs put-retention-policy "${r[@]}" --log-group-name "/aws/lambda/${fn}" --retention-in-days 7

  local zip="${TMPDIR:-/tmp}/${PREFIX}-lambda.zip"
  (cd "${HERE}/lambda" && rm -f "$zip" && zip -q "$zip" handler.py)

  local envvars
  envvars=$(jq -nc --arg t "$table" --arg q "$queue_url" --arg s "$topic_arn" \
    --arg m "$module" --arg u "$SITE_URL" --arg n "$METRIC_NAMESPACE" \
    '{Variables:{TABLE_NAME:$t,QUEUE_URL:$q,TOPIC_ARN:$s,MODULE:$m,SITE_URL:$u,METRIC_NAMESPACE:$n}}')

  if aws lambda get-function "${r[@]}" --function-name "$fn" >/dev/null 2>&1; then
    aws lambda update-function-code "${r[@]}" --function-name "$fn" --zip-file "fileb://${zip}" >/dev/null
    aws lambda wait function-updated "${r[@]}" --function-name "$fn"
    aws lambda update-function-configuration "${r[@]}" --function-name "$fn" \
      --environment "$envvars" >/dev/null
  else
    aws lambda create-function "${r[@]}" --function-name "$fn" \
      --runtime python3.13 --handler handler.handler --role "$role_arn" \
      --zip-file "fileb://${zip}" --timeout 30 --memory-size 128 \
      --tracing-config Mode=Active \
      --environment "$envvars" \
      --tags "$(common_tags_map "$fn" "$module" "$env")" >/dev/null
  fi
  aws lambda wait function-updated "${r[@]}" --function-name "$fn"

  # EventBridge schedule. 5 min => ~26k invocations/month across all targets,
  # against the 1M request / 400k GB-s always-free Lambda allowance.
  local rule="${PREFIX}-tick" rule_arn fn_arn
  rule_arn=$(aws events put-rule "${r[@]}" --name "$rule" \
    --schedule-expression "rate(5 minutes)" --state ENABLED \
    --description "CostGoblin lab heartbeat" \
    --tags $(common_tags_cli "$rule" "$module" "$env") --query RuleArn --output text)
  fn_arn=$(aws lambda get-function "${r[@]}" --function-name "$fn" --query Configuration.FunctionArn --output text)
  aws lambda add-permission "${r[@]}" --function-name "$fn" \
    --statement-id "${rule}-invoke" --action lambda:InvokeFunction \
    --principal events.amazonaws.com --source-arn "$rule_arn" >/dev/null 2>&1 || true
  aws events put-targets "${r[@]}" --rule "$rule" \
    --targets "Id=lambda,Arn=${fn_arn}" >/dev/null

  # One alarm per target — 10 alarms are always free, we use 4.
  aws cloudwatch put-metric-alarm "${r[@]}" --alarm-name "${PREFIX}-idle-${module}" \
    --alarm-description "cg-lab worker stopped reporting" \
    --namespace "$METRIC_NAMESPACE" --metric-name WorkItemsProcessed \
    --dimensions "Name=Module,Value=${module}" \
    --statistic Sum --period 3600 --evaluation-periods 1 \
    --threshold 1 --comparison-operator LessThanThreshold \
    --treat-missing-data breaching --alarm-actions "$topic_arn" \
    --tags $(common_tags_cli "${PREFIX}-idle-${module}" "$module" "$env") >/dev/null

  aws lambda invoke "${r[@]}" --function-name "$fn" \
    --cli-binary-format raw-in-base64-out \
    --payload '{"source":"deploy"}' "${TMPDIR:-/tmp}/${PREFIX}-invoke.json" >/dev/null
  log "[${profile}/${region}] smoke invoke: $(jq -c '.calls' "${TMPDIR:-/tmp}/${PREFIX}-invoke.json" 2>/dev/null || echo '(no body)')"
}

# --------------------------------------------------------------------------
# Step Functions (singleton — 4,000 transitions/month is the tight one)
# --------------------------------------------------------------------------

deploy_stepfunctions() { # $1=profile
  local profile="$1" region="$HOME_REGION" role="${PREFIX}-sfn" name="${PREFIX}-flow"
  local r=(--profile "$profile" --region "$region")
  local acct role_arn fn_arn sm_arn rule_arn events_role_arn

  acct=$(account_id "$profile")
  fn_arn="arn:aws:lambda:${region}:${acct}:function:${PREFIX}-worker"

  if ! role_arn=$(aws iam get-role --profile "$profile" --role-name "$role" --query Role.Arn --output text 2>/dev/null); then
    role_arn=$(aws iam create-role --profile "$profile" --role-name "$role" \
      --tags $(common_tags_cli "$role" orchestration production) \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"states.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      --query Role.Arn --output text)
    aws iam put-role-policy --profile "$profile" --role-name "$role" \
      --policy-name invoke --policy-document "$(jq -nc --arg f "$fn_arn" \
        '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"lambda:InvokeFunction",Resource:$f}]}')"
    sleep 10
  fi

  local definition
  definition=$(jq -nc --arg f "$fn_arn" '{
    Comment:"CostGoblin lab — 5 state transitions per execution",
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

  # rate(2 hours) => 12 executions/day * ~5 transitions = ~1,800/month,
  # comfortably under the 4,000 always-free state transitions.
  local erole="${PREFIX}-sfn-events"
  if ! events_role_arn=$(aws iam get-role --profile "$profile" --role-name "$erole" --query Role.Arn --output text 2>/dev/null); then
    events_role_arn=$(aws iam create-role --profile "$profile" --role-name "$erole" \
      --tags $(common_tags_cli "$erole" orchestration production) \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"events.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      --query Role.Arn --output text)
    aws iam put-role-policy --profile "$profile" --role-name "$erole" \
      --policy-name start --policy-document "$(jq -nc --arg s "$sm_arn" \
        '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"states:StartExecution",Resource:$s}]}')"
    sleep 10
  fi

  rule_arn=$(aws events put-rule "${r[@]}" --name "${PREFIX}-flow-tick" \
    --schedule-expression "rate(2 hours)" --state ENABLED \
    --tags $(common_tags_cli "${PREFIX}-flow-tick" orchestration production) \
    --query RuleArn --output text)
  aws events put-targets "${r[@]}" --rule "${PREFIX}-flow-tick" \
    --targets "Id=sfn,Arn=${sm_arn},RoleArn=${events_role_arn}" >/dev/null
  aws stepfunctions start-execution "${r[@]}" --state-machine-arn "$sm_arn" >/dev/null
  log "[${profile}/${region}] Step Functions ${name} scheduled every 2h"
}

# --------------------------------------------------------------------------
# CodeBuild (singleton — 100 build minutes/month always free)
# --------------------------------------------------------------------------

deploy_codebuild() { # $1=profile
  local profile="$1" region="$HOME_REGION" role="${PREFIX}-codebuild" project="${PREFIX}-build"
  local r=(--profile "$profile" --region "$region")
  local role_arn rule_arn events_role_arn acct
  acct=$(account_id "$profile")

  if ! role_arn=$(aws iam get-role --profile "$profile" --role-name "$role" --query Role.Arn --output text 2>/dev/null); then
    role_arn=$(aws iam create-role --profile "$profile" --role-name "$role" \
      --tags $(common_tags_cli "$role" build development) \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      --query Role.Arn --output text)
    aws iam put-role-policy --profile "$profile" --role-name "$role" \
      --policy-name logs --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"}]}'
    sleep 10
  fi

  local buildspec='version: 0.2
phases:
  build:
    commands:
      - echo "cg-lab synthetic build"'

  if ! aws codebuild batch-get-projects "${r[@]}" --names "$project" \
      --query 'projects[0].name' --output text 2>/dev/null | grep -q "$project"; then
    aws codebuild create-project "${r[@]}" --name "$project" \
      --source "$(jq -nc --arg b "$buildspec" '{type:"NO_SOURCE",buildspec:$b}')" \
      --artifacts '{"type":"NO_ARTIFACTS"}' \
      --environment '{"type":"LINUX_CONTAINER","image":"aws/codebuild/amazonlinux2-x86_64-standard:5.0","computeType":"BUILD_GENERAL1_SMALL"}' \
      --service-role "$role_arn" --timeout-in-minutes 5 \
      --tags $(common_tags_cli_lower "$project" build development) >/dev/null
  fi

  local erole="${PREFIX}-build-events"
  if ! events_role_arn=$(aws iam get-role --profile "$profile" --role-name "$erole" --query Role.Arn --output text 2>/dev/null); then
    events_role_arn=$(aws iam create-role --profile "$profile" --role-name "$erole" \
      --tags $(common_tags_cli "$erole" build development) \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"events.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      --query Role.Arn --output text)
    aws iam put-role-policy --profile "$profile" --role-name "$erole" \
      --policy-name start --policy-document "$(jq -nc --arg p "arn:aws:codebuild:${region}:${acct}:project/${project}" \
        '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"codebuild:StartBuild",Resource:$p}]}')"
    sleep 10
  fi

  # Daily, ~1 billed minute per build => ~30 of the 100 free minutes/month.
  rule_arn=$(aws events put-rule "${r[@]}" --name "${PREFIX}-build-tick" \
    --schedule-expression "rate(1 day)" --state ENABLED \
    --tags $(common_tags_cli "${PREFIX}-build-tick" build development) \
    --query RuleArn --output text)
  aws events put-targets "${r[@]}" --rule "${PREFIX}-build-tick" \
    --targets "Id=codebuild,Arn=arn:aws:codebuild:${region}:${acct}:project/${project},RoleArn=${events_role_arn}" >/dev/null
  aws codebuild start-build "${r[@]}" --project-name "$project" >/dev/null
  log "[${profile}/${region}] CodeBuild ${project} scheduled daily"
}

# --------------------------------------------------------------------------
# Glue Data Catalog (1M objects + 1M requests always free; no crawler — those
# bill at $0.44/DPU-hour and are not free tier)
# --------------------------------------------------------------------------

deploy_glue() { # $1=profile
  local profile="$1" region="$HOME_REGION" db="${PREFIX}_catalog" acct
  local r=(--profile "$profile" --region "$region")
  acct=$(account_id "$profile")
  aws glue create-database "${r[@]}" --database-input \
    "$(jq -nc --arg d "$db" '{Name:$d,Description:"CostGoblin free-tier lab catalog"}')" 2>/dev/null || true
  # Location must be a bucket we own: an unclaimed name could be registered by
  # someone else and would then be an attacker-controlled table target.
  aws glue create-table "${r[@]}" --database-name "$db" --table-input "$(jq -nc --arg loc "s3://${PREFIX}-site-${acct}/events/" '{
    Name:"lab_events",
    TableType:"EXTERNAL_TABLE",
    Parameters:{classification:"json"},
    StorageDescriptor:{
      Columns:[{Name:"run_id",Type:"string"},{Name:"module",Type:"string"},{Name:"region",Type:"string"}],
      Location:$loc,
      InputFormat:"org.apache.hadoop.mapred.TextInputFormat",
      OutputFormat:"org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
      SerdeInfo:{SerializationLibrary:"org.openx.data.jsonserde.JsonSerDe"}
    }}')" 2>/dev/null || true
  log "[${profile}/${region}] Glue database ${db} ready"
}

# --------------------------------------------------------------------------

main() {
  log "deploying CostGoblin free-tier lab"
  deploy_site "$MGMT_PROFILE"
  for target in "${TARGETS[@]}"; do
    IFS='|' read -r profile region module env <<<"$target"
    deploy_regional "$profile" "$region" "$module" "$env"
  done
  deploy_cdn_alarm "$MGMT_PROFILE"
  deploy_stepfunctions "$MGMT_PROFILE"
  deploy_codebuild "$MGMT_PROFILE"
  deploy_glue "$MGMT_PROFILE"
  log "done — FOCUS line items appear within ~24h of the next export refresh"
}

main "$@"
