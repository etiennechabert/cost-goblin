#!/usr/bin/env bash
#
# Deploy the CostGoblin GCP FOCUS exporter as a scheduled Cloud Run job.
#
# Idempotent: safe to re-run to pick up a code change or a config tweak.
# Every step prints what it is doing; nothing is destructive except the
# job/scheduler updates, which replace their own previous revision.
#
#   ./deploy.sh
#
# No local install needed: this runs happily in Cloud Shell, which already has
# gcloud, Docker and your credentials. The README has an "Open in Cloud Shell"
# link, and a copy-paste equivalent of everything below for anyone who would
# rather run the commands directly.
#
set -euo pipefail

# --- edit these ------------------------------------------------------------

# Project that hosts the BigQuery billing export dataset and runs the job.
PROJECT_ID="${PROJECT_ID:-billing-504501}"

# The Google-managed FOCUS export table: project.dataset.table.
# Find it under BigQuery -> gcp_billing_immutable_<BILLING_ACCOUNT_ID>_<location>.
FOCUS_TABLE="${FOCUS_TABLE:-CHANGE_ME.gcp_billing_immutable_XXXXXX_eu.gcp_billing_export_focus_XXXXXX}"

# Destination bucket (no gs://) and key prefix. CostGoblin is then pointed at
# gs://${BUCKET}/${PREFIX}
BUCKET="${BUCKET:-cost-goblin}"
PREFIX="${PREFIX:-focus}"

# MUST match the billing export dataset's location, and the bucket's. BigQuery
# refuses to EXPORT DATA across locations.
LOCATION="${LOCATION:-EU}"

# Cloud Run jobs are regional; pick a region inside ${LOCATION}.
REGION="${REGION:-europe-west1}"

# How often to check for changed periods.
#
# Daily is the right answer for almost everyone: the upstream export only
# refreshes a few times a day, so extra runs mostly find nothing changed — and
# the ones that DO find a change re-export the whole current month, which grows
# through the month. Twice daily ("0 6,18 * * *") is a reasonable step up;
# hourly multiplies month-end scan cost for no real freshness gain. For a
# number right now, run the job on demand instead of raising the schedule.
SCHEDULE="${SCHEDULE:-0 6 * * *}"

# ---------------------------------------------------------------------------

JOB_NAME="${JOB_NAME:-costgoblin-focus-exporter}"
SA_NAME="${SA_NAME:-costgoblin-exporter}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
STATE_DATASET="${STATE_DATASET:-costgoblin_exporter}"
STATE_TABLE="${PROJECT_ID}.${STATE_DATASET}.export_state"

if [[ "${FOCUS_TABLE}" == CHANGE_ME.* ]]; then
  echo "ERROR: set FOCUS_TABLE to your billing export table first (see the top of this file)." >&2
  exit 1
fi

echo "==> Project ${PROJECT_ID}, location ${LOCATION}, region ${REGION}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Enabling required APIs"
gcloud services enable \
  bigquery.googleapis.com \
  storage.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com

echo "==> Watermark dataset ${STATE_DATASET} (in ${LOCATION})"
# The state dataset must sit in the same location as the billing export: the
# exporter joins the two in one query.
bq --location="${LOCATION}" mk --dataset --force "${PROJECT_ID}:${STATE_DATASET}" >/dev/null

echo "==> Service account ${SA_EMAIL}"
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="CostGoblin FOCUS exporter" 2>/dev/null || echo "    (already exists)"

echo "==> Granting roles"
# Run BigQuery jobs, and read the billing export.
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/bigquery.jobUser" --condition=None >/dev/null
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/bigquery.dataViewer" --condition=None >/dev/null
# Write the watermark table.
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/bigquery.dataEditor" --condition=None >/dev/null
# objectAdmin, not objectCreator: deleting each period's folder before the
# re-export is the whole point of this job.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin" >/dev/null

echo "==> Building and deploying the job"
gcloud run jobs deploy "${JOB_NAME}" \
  --source=. \
  --region="${REGION}" \
  --service-account="${SA_EMAIL}" \
  --tasks=1 \
  --max-retries=1 \
  --task-timeout=30m \
  --set-env-vars="FOCUS_TABLE=${FOCUS_TABLE},BUCKET=${BUCKET},PREFIX=${PREFIX},STATE_TABLE=${STATE_TABLE},BQ_LOCATION=${LOCATION}"

echo "==> Scheduling (${SCHEDULE})"
SCHEDULER_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"
gcloud scheduler jobs create http "${JOB_NAME}-trigger" \
  --location="${REGION}" \
  --schedule="${SCHEDULE}" \
  --uri="${SCHEDULER_URI}" \
  --http-method=POST \
  --oauth-service-account-email="${SA_EMAIL}" \
  2>/dev/null \
  || gcloud scheduler jobs update http "${JOB_NAME}-trigger" \
       --location="${REGION}" \
       --schedule="${SCHEDULE}" \
       --uri="${SCHEDULER_URI}" \
       --http-method=POST \
       --oauth-service-account-email="${SA_EMAIL}"

# The scheduler authenticates as the same service account, so it needs to be
# allowed to start the job it owns.
gcloud run jobs add-iam-policy-binding "${JOB_NAME}" \
  --region="${REGION}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker" >/dev/null

cat <<EOF

Deployed.

  Run it now:      gcloud run jobs execute ${JOB_NAME} --region=${REGION} --wait
  Watch the logs:  gcloud run jobs executions logs read --job=${JOB_NAME} --region=${REGION}
  See the output:  gcloud storage ls gs://${BUCKET}/${PREFIX}/

Then point CostGoblin at:  gs://${BUCKET}/${PREFIX}
EOF
