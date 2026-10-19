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

`config/apply.md` is read from `main` only, so a PR can't widen its own auto-apply limits. `config/risk.md` combines `main`'s copy with what the PR adds. The review guides and rules come from the PR's head: a PR can edit the rules it is judged by, so read `.gitar/` diffs closely, and a branch cut before a `.gitar/` change runs without it until it merges `main` (#718 and #719 showed "No rules evaluated").

Gitar also reads the .claude/rules and .cursor/rules directories and discovers skills in .agents/skills (release notes, 2026-09-17), and Sonar's Gitar guide adds a root AGENTS.md. None exist here; anything added there reaches every run without the checks below.

## Keeping it useful

- `scripts/ci/gitar-config.test.mjs` (part of `npm run check`) fails when a file here names a path or identifier that no longer exists, when a rule or skill lacks the frontmatter Gitar reads, or when `review/` plus `instructions/` outgrow their 32 KB budget. Those two load on every run, so add only what changes what Gitar finds; put long procedures in a skill, which loads only when called. When the budget is tight, make room by cutting a line that restates CLAUDE.md (Gitar loads it too) rather than dropping a lesson.
- On the free open-source plan Gitar's Knowledge feature is not available, so a reply settles that PR only. Write lessons down instead: a valid finding of a general kind becomes a check in the matching `review/` file, and a false positive that comes back becomes a line in its "Intentional, don't flag" list (CLAUDE.md, "Gitar review").
- Gitar filters these files before each review, so keep every instruction under a heading that matches it. On #716 a "flag this" note placed inside the "Don't comment on" list was dropped.
- Debug a rule with a `gitar display:verbose` comment: it shows why each rule matched or was skipped.
- Sonar's Gitar guide gives Pro, whose features the open-source plan includes, up to five custom rules per organization (docs.gitar.ai doesn't state the cap); three are used here.

## On the PR

- Reply to a finding to explain, agree or disagree; reply `gitar fix` (or tick its checkbox) to have Gitar commit the fix.
- `gitar review` requests a review; `gitar auto-apply:on` / `:off` lets Gitar commit fixes for the rest of the PR, within `config/apply.md`. The `gitar-managed` label turns auto-apply on too.
- `gitar display:verbose` / `:compact` switches how much of the verification the comment shows.
- The `gitar-skip` label skips automatic processing for a PR.
- Gitar replaces its summary comment as the PR moves, and the CI-failure analysis lives in it. React on the final copy, and quote an analysis in your reply if you answer it.

## Dashboard settings

These live in the Gitar dashboard (app.gitar.ai, Settings → Configuration), not in the repository:

- **Allowed bots**: add `dependabot[bot]`. Bot PRs are skipped by default, so Gitar neither reviews dependency bumps nor explains their CI failures until it is listed. It is unverified: no Dependabot PR has been opened or updated since Gitar started reviewing. A `@dependabot rebase` on an open one (#703–#707) will show it.
- **Retry unrelated CI failures**: on. Gitar re-runs a job when its failure has nothing to do with the PR, such as a flaky e2e shard. It also re-runs a job that fails because `main` is broken (#744, #748): the docs list target-branch failures as retryable, and the toggle, not `instructions/`, decides. A re-run tests the same merge commit, so if that keeps happening, turn the toggle off.
- **Skip drafts**: on, so a draft's work-in-progress pushes don't use up the review budget.
- **Enhance summaries**: off. PR descriptions here are written in full and shouldn't be rewritten.
- **Auto-approve / auto-merge**: off. Admins bypass the `main` ruleset's required approval anyway, and a Gitar approval would satisfy that approval for Dependabot and contributor PRs. Auto-approve needs no approve.md: with the toggle on, Gitar approves once its findings are resolved, so the toggle alone keeps approvals off. It was on briefly at setup: Gitar approved #716 and #718 (2026-10-17 22:19Z, both dismissed). There is no merge.md under `config/` either; a repository without one is never armed only when the organization requires the per-repository file (release notes, 2026-08-28), so the auto-merge toggle is what keeps it off.
- **Merge blocking**: off, or decide a threshold. When on, Gitar submits a review that blocks merging while findings at or above the threshold are open; it did on #717 (2026-10-17 22:18Z, since dismissed). Admins bypass the `main` ruleset, so it binds contributors only. `gitar unblock` dismisses that review once an admin enables the command.
