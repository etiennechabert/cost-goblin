---
name: run-desktop
description: Not available in Gitar runs. Launching the desktop app needs the maintainer's machine and display.
disable-model-invocation: true
---

# run-desktop is local-only

This file overrides `.claude/skills/run-desktop/SKILL.md` for Gitar. That skill is for the maintainer's own Claude Code sessions: it merges `main` into the branch and opens an Electron window, and neither belongs in a PR run.

If someone asks you to run the app, say you can't from a pull request, and name the Playwright suite in `e2e/` that covers the behavior in question (each one runs as a `test-e2e` CI shard). Don't pull, merge or push on this skill's behalf.
