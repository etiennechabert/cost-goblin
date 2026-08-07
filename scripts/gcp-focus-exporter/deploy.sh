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

# `--source=.` uploads the build context from the working directory, and every
# IAM and dataset mutation below happens BEFORE that step — so a run from the
# repo root would grant all the permissions and only then fail with the wrong
# build context. Anchor to this script's own directory instead.
cd "$(dirname "${BASH_SOURCE[0]}")"

# --- edit these ------------------------------------------------------------

# Project that hosts the job. Defaults to the project of the billing export
# table, so the common single-project setup needs no value here.
PROJECT_ID="${PROJECT_ID:-}"

# The Google-managed FOCUS export table: project.dataset.table.
# Find it under BigQuery -> gcp_billing_immutable_<BILLING_ACCOUNT_ID>_<location>.
FOCUS_TABLE="${FOCUS_TABLE:-CHANGE_ME.gcp_billing_immutable_XXXXXX_eu.gcp_billing_export_focus_XXXXXX}"

# Destination bucket (no gs://) and key prefix. Each tier gets its own folder
# beneath the prefix, so CostGoblin is pointed at
# gs://${BUCKET}/${PREFIX}/daily  (and .../hourly, if you publish it)
BUCKET="${BUCKET:-}"
PREFIX="${PREFIX:-focus}"

# Which grains to publish: "daily", "hourly", or "daily,hourly".
#
# The upstream FOCUS export is HOURLY, so "daily" is a rollup this job computes
# — one row per day per dimension tuple, measures summed. It is the default
# because it is roughly 24x smaller, which is the whole reason the tier split
# exists: keep a year of daily and a fortnight of hourly, not a year of hourly.
# Add "hourly" only if you actually want intraday charts, and give it a short
# retentionDays in costgoblin.yaml when you do.
TIERS="${TIERS:-daily}"

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

# FOCUS_TABLE is project.dataset.table. Both halves are needed below: the
# dataset ACL has to be granted in the project that OWNS the billing export,
# which is not necessarily the project running the job.
BILLING_PROJECT="$(printf '%s' "${FOCUS_TABLE}" | cut -d. -f1)"
BILLING_DATASET="$(printf '%s' "${FOCUS_TABLE}" | cut -d. -f2)"
PROJECT_ID="${PROJECT_ID:-${BILLING_PROJECT}}"

if [[ -z "${BUCKET}" ]]; then
  echo "ERROR: set BUCKET to the destination bucket (no gs://)." >&2
  exit 1
fi

# Recomputed here: the defaults above are evaluated before PROJECT_ID resolves.
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
STATE_TABLE="${PROJECT_ID}.${STATE_DATASET}.export_state"

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
# Running a BigQuery job is a project-level permission, so this one has to be
# granted at the project. It confers no data access on its own.
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/bigquery.jobUser" --condition=None >/dev/null

# Data access is granted per DATASET, not project-wide. Project-level
# dataViewer/dataEditor would let this service account read and write every
# dataset in the project — it needs to read exactly one (the billing export)
# and write exactly one (its own watermark table).
#
# Dataset ACLs rather than `bq add-iam-policy-binding --dataset`, which still
# requires allowlisting and fails with "This feature requires allowlisting".
#
# Takes the OWNING PROJECT explicitly: the billing export commonly lives in a
# dedicated billing project while the job runs in an ops project, and
# qualifying its dataset with PROJECT_ID would look up a dataset that does not
# exist there — aborting under `set -e` after the service account and the
# project-level binding had already been created.
grant_dataset_access() {   # project, dataset_id, READER|WRITER
  local project="$1" dataset="$2" role="$3" tmp
  tmp=$(mktemp)
  bq show --format=prettyjson "${project}:${dataset}" > "${tmp}"
  python3 - "${tmp}" "${role}" "${SA_EMAIL}" <<'PYEOF'
import json, sys
path, role, member = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
access = d.setdefault('access', [])
entry = {'role': role, 'userByEmail': member}
if entry not in access:
    access.append(entry)
json.dump(d, open(path, 'w'))
PYEOF
  bq update --source "${tmp}" "${project}:${dataset}" >/dev/null
  rm -f "${tmp}"
}

# Read the billing export (in whichever project owns it); write our own
# watermark dataset (always in the job's project).
grant_dataset_access "${BILLING_PROJECT}" "${BILLING_DATASET}" READER
grant_dataset_access "${PROJECT_ID}" "${STATE_DATASET}" WRITER
# objectAdmin, not objectCreator: deleting each period's folder before the
# re-export is the whole point of this job.
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin" >/dev/null

echo "==> Building and deploying the job"
# `^;^` switches --set-env-vars to a semicolon delimiter. TIERS=daily,hourly
# contains a comma, which is gcloud's DEFAULT delimiter — with it, the value
# would be split and the job would deploy with a bare `hourly=` variable and
# TIERS truncated to `daily`.
gcloud run jobs deploy "${JOB_NAME}" \
  --source=. \
  --region="${REGION}" \
  --service-account="${SA_EMAIL}" \
  --tasks=1 \
  --max-retries=1 \
  --task-timeout=30m \
  --set-env-vars="^;^FOCUS_TABLE=${FOCUS_TABLE};BUCKET=${BUCKET};PREFIX=${PREFIX};TIERS=${TIERS};STATE_TABLE=${STATE_TABLE};BQ_LOCATION=${LOCATION}"

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
