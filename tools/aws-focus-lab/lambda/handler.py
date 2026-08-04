"""Synthetic always-free workload that produces varied FOCUS line items.

Every invocation touches DynamoDB, SQS, SNS and CloudWatch so the AWS FOCUS
export gains rows across several service categories. Deliberately tiny: see
tools/aws-focus-lab/README.md for the free-tier headroom calculation.
"""

import json
import os
import time
import urllib.error
import urllib.request
import uuid

import boto3

REGION = os.environ["AWS_REGION"]
TABLE_NAME = os.environ.get("TABLE_NAME", "")
QUEUE_URL = os.environ.get("QUEUE_URL", "")
TOPIC_ARN = os.environ.get("TOPIC_ARN", "")
SITE_URL = os.environ.get("SITE_URL", "")
MODULE = os.environ.get("MODULE", "unknown")
NAMESPACE = os.environ.get("METRIC_NAMESPACE", "CostGoblinLab")

ddb = boto3.client("dynamodb")
sqs = boto3.client("sqs")
sns = boto3.client("sns")
cw = boto3.client("cloudwatch")


def _dynamo_roundtrip(run_id):
    """One write + one read. 1 WCU / 1 RCU is plenty at this call rate."""
    now = int(time.time())
    key = {"pk": {"S": f"run#{run_id}"}, "sk": {"S": str(now)}}
    ddb.put_item(
        TableName=TABLE_NAME,
        Item={
            **key,
            "module": {"S": MODULE},
            "region": {"S": REGION},
            # TTL keeps the table well inside the 25 GB free allowance.
            "expires_at": {"N": str(now + 86400)},
        },
    )
    ddb.get_item(TableName=TABLE_NAME, Key=key)
    return 2


def _sqs_roundtrip(run_id):
    """Send, receive, delete — 3 requests against the 1M/month allowance."""
    sqs.send_message(
        QueueUrl=QUEUE_URL,
        MessageBody=json.dumps({"run_id": run_id, "module": MODULE}),
    )
    received = sqs.receive_message(QueueUrl=QUEUE_URL, MaxNumberOfMessages=10, WaitTimeSeconds=1)
    for message in received.get("Messages", []):
        sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=message["ReceiptHandle"])
    return 2 + len(received.get("Messages", []))


def _sns_publish(run_id):
    sns.publish(
        TopicArn=TOPIC_ARN,
        Subject="cg-lab heartbeat",
        Message=json.dumps({"run_id": run_id, "module": MODULE, "region": REGION}),
    )
    return 1


def _fetch_site():
    """Drive CloudFront request + data-transfer-out meters."""
    if not SITE_URL:
        return 0
    try:
        with urllib.request.urlopen(SITE_URL, timeout=5) as response:
            response.read()
        return 1
    except (urllib.error.URLError, TimeoutError) as exc:
        print(json.dumps({"level": "warn", "msg": "site fetch failed", "error": str(exc)}))
        return 0


def handler(event, context):
    run_id = str(uuid.uuid4())
    started = time.time()
    calls = {}

    for name, fn in (
        ("dynamodb", _dynamo_roundtrip),
        ("sqs", _sqs_roundtrip),
        ("sns", _sns_publish),
    ):
        try:
            calls[name] = fn(run_id)
        except Exception as exc:  # keep one failing service from killing the run
            print(json.dumps({"level": "error", "service": name, "error": str(exc)}))
            calls[name] = 0

    calls["cloudfront"] = _fetch_site()
    elapsed_ms = round((time.time() - started) * 1000, 1)

    # Exactly one custom metric name, one dimension value per deployment, to
    # stay inside the 10-custom-metric always-free allowance.
    try:
        cw.put_metric_data(
            Namespace=NAMESPACE,
            MetricData=[
                {
                    "MetricName": "WorkItemsProcessed",
                    "Dimensions": [{"Name": "Module", "Value": MODULE}],
                    "Value": float(sum(calls.values())),
                    "Unit": "Count",
                }
            ],
        )
    except Exception as exc:
        print(json.dumps({"level": "error", "service": "cloudwatch", "error": str(exc)}))

    print(json.dumps({
        "level": "info",
        "run_id": run_id,
        "module": MODULE,
        "region": REGION,
        "elapsed_ms": elapsed_ms,
        "calls": calls,
    }))

    return {"run_id": run_id, "calls": calls, "elapsed_ms": elapsed_ms}
