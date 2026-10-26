# Contributing to CostGoblin

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Sign the CLA once, in your first pull request

CostGoblin is AGPL-3.0. Contributors accept a short Contributor License
Agreement, [`CLA.md`](CLA.md), once. You keep the copyright in your work; the
agreement lets the maintainer keep CostGoblin open source while also offering
it under other terms, such as a commercial license or a paid edition for
companies.

To sign, add one row to the end of the table in
[`.github/cla-signatures.md`](.github/cla-signatures.md), in your pull request:

```markdown
| @your-github-login | Your full name | YYYY-MM-DD | 1.0 |
```

The **CLA** check on the pull request then verifies that every commit author
has signed:

- Each commit must be authored with an email linked to your GitHub account
  (Settings → Emails), so the check can tell who wrote it.
- Everyone signs for themselves. If someone co-authored your changes, ask them
  to add their own row too: the check can't see `Co-authored-by` credits, so
  that one relies on you.
- Whoever opens the pull request signs too, since they submit all of it. That
  signature also covers commits an AI coding agent wrote for you (Claude Code,
  for instance, commits as `Claude <noreply@anthropic.com>`).
- Signing covers your later contributions too, so you only do it once.

## Making a change

1. `make dev` installs dependencies and launches the app
   ([Quick Start](README.md#quick-start)).
2. Keep the change focused, with tests alongside it.
3. Run `npm run check` before you push: it's what CI runs (type check, lint,
   tests).

Found a security problem? Please don't open a public issue: use the contact
details on [costgoblin.com/imprint.html](https://costgoblin.com/imprint.html).

## Updating the Nix flake

The flake pins the version and the npm dependency hash, so both need a refresh
when a release changes them.

1. Set `version` in `flake.nix` to the version in `package.json`.
2. If `package-lock.json` changed, clear `npmDepsHash` and run `nix build
   --no-link`. The build fails with the correct hash; paste it into `flake.nix`.
3. Run `nix flake update`, then `nix build --no-link` and `nix run .` to verify.
