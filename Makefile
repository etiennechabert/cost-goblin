.PHONY: deps dev prod reset test e2e e2e-core e2e-config e2e-stress perf perf-queries lint dist dist-mac dist-win dist-linux release help
.DEFAULT_GOAL := help

BUILD = npm run build --workspace=packages/desktop
INSTALLED_LOCK = node_modules/.installed-package-lock.json

# A pull or branch switch can change package-lock.json without reinstalling.
# Compare contents, not mtimes: a checkout rewrites the lockfile even when it
# is unchanged.
deps: ## Install dependencies when package-lock.json differs from the last install
	@cmp -s package-lock.json $(INSTALLED_LOCK) 2>/dev/null || \
		{ echo "package-lock.json differs from the last install: running npm ci"; \
		  npm ci && cp package-lock.json $(INSTALLED_LOCK); }

dev: deps ## Launch Electron in dev mode
	cd packages/desktop && npm run dev

# Launch the package directory, not out/main/main.js: Electron names the app
# from its package.json, so userData matches `make dev` (@costgoblin/desktop)
# instead of a generic "Electron" folder with no workspaces.
prod: deps ## Build and launch Electron in production mode
	$(BUILD)
	npx electron packages/desktop

reset: ## Wipe app data and config — next launch shows wizard
	rm -rf "$(HOME)/Library/Application Support/@costgoblin"
	@echo "Cleared app data and config — next launch will show the wizard"

test: deps ## Run vitest
	npx vitest run

# The e2e, perf and lint targets run the root package.json scripts, which are
# what CI and `npm run check` run. Copies of their commands here drifted from
# them (#465).
e2e: deps ## Build and run every E2E suite CI runs
	npm run e2e

e2e-core: deps ## Build and run core views E2E (Overview, Trends, etc.)
	npm run e2e:core

e2e-config: deps ## Build and run config views E2E (Sync, Dims, Scope)
	npm run e2e:config

e2e-stress: deps ## Build and run widget growth stress tests
	npm run e2e:stress

dist: deps ## Build distributable installer for current platform
	npm run build --workspaces
	npx --no-install electron-builder --publish never

dist-mac: deps ## Build macOS .dmg and .zip (current arch only)
	npm run build --workspaces
	npx --no-install electron-builder --mac --arm64 --publish never

dist-win: deps ## Build Windows .exe installer
	npm run build --workspaces
	npx --no-install electron-builder --win --publish never

dist-linux: deps ## Build Linux .AppImage and .deb
	npm run build --workspaces
	npx --no-install electron-builder --linux --publish never

# main already carries the version to release: the first PR after a release
# bumps both package.json files one release past the latest tag (CLAUDE.md,
# "Versioning & releases"). So a release only tags that commit; bumping here
# too would skip a version. Pushing the tag starts release.yml, which builds
# the tagged commit and stops unless the tag equals both versions.
#
# Untracked files don't block it: no tag contains them. Fetching main into a
# destination ref also fetches the tags on it (a bare `git fetch origin main`
# doesn't), so a tag pushed from another clone counts as existing. Offline,
# the checks use what was fetched last.
release: ## Tag the current package.json version for release (no bump, no push)
	@set -e; \
	if [ -n "$$(git status --porcelain --untracked-files=no)" ]; then \
		echo "release: uncommitted changes, which the tag would not contain. Commit or stash them first." >&2; exit 1; \
	fi; \
	version=$$(node -p 'require("./package.json").version'); \
	desktop=$$(node -p 'require("./packages/desktop/package.json").version'); \
	if [ "$$version" != "$$desktop" ]; then \
		echo "release: package.json ($$version) and packages/desktop/package.json ($$desktop) disagree. Bump both in a PR first." >&2; exit 1; \
	fi; \
	if ! printf '%s\n' "$$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$'; then \
		echo "release: package.json version '$$version' is not X.Y.Z." >&2; exit 1; \
	fi; \
	GIT_TERMINAL_PROMPT=0 git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' || \
		echo "release: warning: could not fetch origin; checking HEAD against the last-fetched origin/main." >&2; \
	upstream=$$(git rev-parse -q --verify 'refs/remotes/origin/main^{commit}') || upstream=; \
	if [ -z "$$upstream" ]; then \
		echo "release: warning: no origin/main to check HEAD against." >&2; \
	elif [ "$$(git rev-parse HEAD)" != "$$upstream" ]; then \
		echo "release: HEAD is not origin/main ($$(git rev-parse --short "$$upstream")). Release from an up-to-date main: git switch main && git pull --ff-only" >&2; exit 1; \
	fi; \
	tag="v$$version"; \
	if git rev-parse -q --verify "refs/tags/$$tag" >/dev/null; then \
		echo "release: $$tag already exists. If it was never pushed: git push origin $$tag. Otherwise merge a PR that bumps both package.json files first." >&2; exit 1; \
	fi; \
	git tag -a "$$tag" -m "Release $$tag"; \
	echo "Tagged $$tag at $$(git rev-parse --short HEAD). Push it to start the release (release.yml):"; \
	echo "  git push origin $$tag"

perf: deps ## Build and run performance benchmarks
	npm run perf

perf-queries: deps ## Build and run query performance diagnostics
	npm run perf:queries

lint: deps ## Run tsc + eslint over every package
	npm run lint

help: ## Show available commands
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
