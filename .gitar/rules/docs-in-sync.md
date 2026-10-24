---
title: "Docs match behavior"
description: "README, SPEC.md, setup docs, CLAUDE.md and .gitar/ stay true when user-facing behavior or a documented convention changes"
type: check
when: "PRs that change user-facing setup, configuration, on-disk layout or permissions, or a convention that CLAUDE.md or .gitar/ states"
actions: "Mark the check unmet, quote each statement the PR makes false, and say what is true now"
---

# Docs match behavior

The check is unmet when the PR makes a statement in one of these files false without updating it in the same PR:

- `README.md`. Above all "Prerequisites" (AWS Data Exports setup, AWS credentials, GCP), "Security & data at rest" (where data is stored, which files hold secrets and are written with mode `0600`), the update-check and MCP descriptions, and every `COSTGOBLIN_*` environment variable it documents.
- `SPEC.md`, mainly "Configuration System" (config file keys and their meaning) and "Setup Requirements for Users".
- `scripts/gcp-focus-exporter/README.md`, the guide users follow to deploy the GCP exporter: permissions, deploy commands, the bucket layout it writes.
- `slides/aws.md` and `slides/gcp.md`, the onboarding video decks. They quote the setup wizard's labels and the two setup guides word for word, so a renamed label or a changed setup step makes them false.
- `CLAUDE.md` and `.gitar/`: a command, CI job, file path, helper name or rule they state, such as a helper renamed out from under CLAUDE.md's "SQL Security" section.

The design records in `docs/*-design.md` are history, not part of this check. Internal refactors, tests and visual changes that no doc describes are out of scope too: say nothing for those.
