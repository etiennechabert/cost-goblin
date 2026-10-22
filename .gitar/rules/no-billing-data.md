---
title: "No billing data or credentials"
description: "Keep real billing exports, data-directory contents and cloud credentials out of this public repository"
type: check
when: "Every pull request, whatever it changes: tests-only, docs-only and config-only PRs included"
actions: "Mark the check unmet and name each offending file and line"
---

# No billing data or credentials

The repository is public, and CostGoblin users' billing data must never reach it. The pre-commit hook blocks the raw data directory locally, but it can be skipped and contributors may not have it. CLAUDE.md's "Fixture Data" section says what may be committed.

The check is unmet when the PR adds or modifies:

- Any file under `data/` other than `data/.gitignore` and `data/.gitkeep`.
- A `.parquet` file anywhere. Synthetic Parquet is generated at test time and never committed.
- A `.csv` file outside `packages/core/src/__fixtures__/focus-1-2/samples/`.
- A billing-shaped file outside `packages/core/src/__fixtures__/`: rows carrying FOCUS columns such as `BilledCost` or `BillingAccountId`, or CUR columns such as `line_item_unblended_cost`.
- A cloud credential: an AWS access key id (`AKIA` or `ASIA` followed by 16 uppercase letters or digits) or secret key, a GCP service-account key (JSON with `"private_key"`), an OAuth refresh token, a `.env` file holding values, or a Sentry auth token.

Synthetic values under `packages/core/src/__fixtures__/` are expected, and so are public identifiers such as a Sentry DSN or a Turnstile site key. Report each offending file and line, and nothing else.
