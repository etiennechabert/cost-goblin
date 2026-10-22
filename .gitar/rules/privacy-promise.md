---
title: "Privacy promise holds"
description: "Keep the app's local-only promise and costgoblin.com's GDPR privacy policy true"
type: check
when: "PRs that change what leaves a user's machine, what the app listens on, or what costgoblin.com loads or collects, and PRs that change what README.md, SPEC.md or docs/ say about any of these"
actions: "Mark the check unmet and quote the promise or policy statement the change makes false"
---

# Privacy promise holds

**The app.** README promises that billing data stays local. Today data leaves the machine only for:

- the user's own cloud accounts, with the user's own credentials: S3 and GCS reads, AWS Organizations, the public SSM region list, Google's token endpoints for the "Signed in as" panel, plus two explicit writes (publishing a config bundle to S3 and opening an AWS Support case);
- GitHub Releases, for the update check (packaged builds, can be turned off);
- Sentry, after the user turns telemetry on, with events scrubbed;
- a teammate holding the sharing key (peer sharing, opt-in), and AI assistants through the opt-in, loopback-only MCP server;
- links the user clicks, which open in the system browser.

The check is unmet when a PR adds a destination or a listener, sends new kinds of data to one of these, adds an install or device identifier, or turns an opt-in path on by default or removes its off switch. It stays unmet until the change is opt-in, can be switched off, and README says so. Cost figures, tag values, account ids and names, bucket names, SQL text, usernames and file paths must never reach Sentry or anywhere else, and the app sends nothing to costgoblin.com. Docs gain no new absolute claims such as "never leaves your machine"; `packages/core/src/__tests__/docs-security-claims.test.ts` bans the ones already known to be false.

**The website.** `docs/privacy.html` lists every third party the site uses (Cloudflare hosting, Cloudflare Turnstile, Bunny Fonts) and every field `workers/signup` stores (email, IP address, user agent, timestamp), along with when each is deleted. The check is unmet when a PR changes `docs/*.html` or `workers/signup/` to load a new third-party resource (script, font, image, frame, analytics), set a cookie, collect or store a new field, or keep data longer, unless the same PR updates `docs/privacy.html` and its "Last updated" date.

Changes that send, load and store nothing new are out of scope: say nothing.
