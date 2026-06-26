---
name: run-desktop
description: Launch and drive the CostGoblin Electron desktop app in dev mode. Use when asked to run/start the app, open it, see a change working in the real app, or manually test the UI. Syncs the branch first (pull --ff-only, then merge latest main) and covers the git-worktree @costgoblin symlink fix required so the app runs the current branch's source.
---

# Running the CostGoblin desktop app

CostGoblin is an Electron app (electron-vite + React renderer, DuckDB workers).
"Running" means launching the real Electron window and interacting with it —
not the test suite.

## Before launch — sync the branch (always, first)

Run this from the repo / worktree root **before** building or launching, so the
app reflects the latest pushed work on this branch AND the latest `main`:

```bash
git fetch origin

# 1. Fast-forward THIS branch from its own remote (skipped if it has no upstream)
if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
  git pull --ff-only
fi

# 2. Bring in the latest main by MERGING it into this branch
git merge origin/main
```

Default branch is `main` here (detect if ever unsure:
`git remote show origin | sed -n '/HEAD branch/s/.*: //p'` — may be `master`).

Rules:

- **Step 1 — diverged from origin → STOP.** If `git pull --ff-only` fails because
  the branch has diverged from its own remote (not a fast-forward), do **not**
  launch and do **not** force anything. Surface it and let the user decide how to
  reconcile.
- **Step 2 — merge, resolve best-effort.** Use `git merge origin/main` (a merge
  commit, not a rebase — never rewrite this branch's history). If it conflicts,
  read both sides and resolve them as best you can keeping both intents, then
  `git commit` the merge and report what you resolved. Only if a conflict is
  genuinely ambiguous/risky should you `git merge --abort` and ask the user.
- **Dirty tree.** The merge needs a clean-enough tree — at the start of `/run`
  it usually is. If there are uncommitted changes that block the merge, `git
  stash` first and `git stash pop` after (or commit them).
- Both `fetch` and `merge` are no-ops when already up to date — this is cheap to
  run every launch.

## Launch (normal checkout)

```bash
cd packages/desktop && npm run dev
```

`npm run dev` runs `build:worker && build:preload && electron-vite dev`, so the
DuckDB/sync worker bundles are rebuilt automatically — no separate build step.

It is long-running. Launch it in the background and watch the log; don't block
on it. Success looks like:

```
dev server running for the electron renderer process at:
  ➜  Local:   http://localhost:5173/
starting electron app...
INFO DuckDB worker ready
INFO Sync worker ready
INFO Window created
INFO query:costs ... materialized=true
```

When you see `Window created` and `materialized=true` query lines, the window
is up and populated. The renderer is served at `http://localhost:5173/`, but it
is an Electron renderer (depends on the main process for IPC) — drive the actual
window, not a bare browser tab.

### Data

The app loads the user's real synced data from the Electron `userData` path
(not `data/` in the repo) — no fixture flag needed to see a populated dashboard.
A fixture dataset can be forced with the `--fixture-mode` flag (used by E2E).

### Benign startup noise (not failures)

- `Auto-sync: failed ... Token is expired ... aws sso login` — only sync needs
  AWS creds; the UI works fine without them.
- `Keychain lookup failed ... userCanceledErr (-128)` — a macOS keychain prompt
  was dismissed; does not block the app.

## Launch from a git worktree — REQUIRED symlink fix first

Worktrees live under `.claude/worktrees/<name>/`. A worktree's `node_modules`
has **no `@costgoblin/*` entries**, and there is no vite alias for them, so
Node/vite resolves `@costgoblin/ui` / `@costgoblin/core` by walking up to the
**main checkout's** `node_modules/@costgoblin/*` — i.e. it runs the *wrong
branch's* source (or fails to resolve). The app would launch but NOT show your
branch's changes.

Fix it once per worktree, from the worktree root, before `npm run dev`:

```bash
mkdir -p node_modules/@costgoblin
for p in core desktop mcp ui; do
  ln -sfn "../../packages/$p" "node_modules/@costgoblin/$p"
done
```

Verify the link points at the worktree (not the main checkout):

```bash
node -e "console.log(require('fs').realpathSync('node_modules/@costgoblin/ui'))"
# → .../.claude/worktrees/<name>/packages/ui   ✅ (worktree)
# → /Users/.../cost-goblin/packages/ui          ❌ (main checkout — fix not applied)
```

`node_modules/` is gitignored, so these symlinks are local-only and never
committed.

## Driving / verifying a change

Open the relevant view and interact — e.g. the date-range picker lives in the
dashboard header: click the date button → **Custom range…** → click a start day
then an end day; the span between them should highlight (single range calendar).

## Stopping

Kill the background `npm run dev` process (Ctrl-C, or stop the background task).
