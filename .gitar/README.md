# Gitar configuration

[Gitar](https://docs.gitar.ai) reviews every pull request (`gitar-bot[bot]`), analyzes failing CI and can push fixes. It reads this directory on each run, alongside `CLAUDE.md` and the skills in `.claude/skills/`. Gitar's docs list only the subdirectories below as configuration; this README is for maintainers.

| Path | Loaded | What it does |
| - | - | - |
| `instructions/` | every run (review, CI analysis, fixes, rules) | How to read CLAUDE.md, where things live, what each CI job runs, limits on what Gitar may commit |
| `review/` | every review | What to look for, per area, and what not to comment on |
| `rules/` | evaluated on every PR | Checks that show up under **Verification** in Gitar's PR comment |
| `config/risk.md` | every review | Raises Gitar's Low/Medium/High risk label for sensitive areas. It can't lower it |
| `config/apply.md` | only when auto-apply is on for a PR | Which review findings Gitar may fix on its own |
| `skills/run-desktop/` | never (model invocation off) | Stops Gitar from running the local-only Claude Code skill of the same name |

`config/apply.md` is read from `main` only, so a PR can't widen its own auto-apply limits. `config/risk.md` combines `main`'s copy with what the PR adds.

## Keeping it useful

- `scripts/ci/gitar-config.test.mjs` (part of `npm run check`) fails when a file here names a path or identifier that no longer exists, when a rule or skill lacks the frontmatter Gitar reads, or when `review/` plus `instructions/` outgrow their 28 KB budget. Those two load on every run, so add only what changes what Gitar finds; put long procedures in a skill, which loads only when called.
- On the free open-source plan Gitar's Knowledge feature is not available, so explaining a false positive in a reply settles that PR only. When the same wrong finding comes back, add a line to the matching `review/` file instead.
- Debug a rule with a `gitar display:verbose` comment: it shows why each rule matched or was skipped.

## On the PR

- Reply to a finding to explain, agree or disagree; reply `gitar fix` (or tick its checkbox) to have Gitar commit the fix.
- `gitar review` requests a review; `gitar auto-apply:on` / `:off` lets Gitar commit fixes for the rest of the PR, within `config/apply.md`.
- The `gitar-skip` label skips automatic processing for a PR.

## Dashboard settings

These live in the Gitar dashboard (app.gitar.ai, Settings → Configuration), not in the repository:

- **Allowed bots**: add `dependabot[bot]`. Bot PRs are skipped by default, so Gitar neither reviews dependency bumps nor explains their CI failures until it is listed.
- **Retry unrelated CI failures**: on. Gitar re-runs a job once per commit when its failure has nothing to do with the PR, such as a flaky e2e shard.
- **Skip drafts**: on, so a draft's work-in-progress pushes don't use up the review budget.
- **Enhance summaries**: off. PR descriptions here are written in full and shouldn't be rewritten.
- **Auto-approve / auto-merge**: off. Admins bypass the `main` ruleset's required approval anyway, and a Gitar approval would satisfy that approval for Dependabot and contributor PRs.
