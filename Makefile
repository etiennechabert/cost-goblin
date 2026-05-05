.PHONY: dev prod reset test e2e e2e-core e2e-config e2e-stress perf lint dist dist-mac dist-win dist-linux release help
.DEFAULT_GOAL := help

BUILD = npm run build --workspace=packages/desktop

dev: ## Launch Electron in dev mode
	cd packages/desktop && npm run dev

prod: ## Build and launch Electron in production mode
	$(BUILD)
	npx electron packages/desktop/out/main/main.js

reset: ## Wipe app data and config — next launch shows wizard
	rm -rf "$(HOME)/Library/Application Support/@costgoblin"
	@echo "Cleared app data and config — next launch will show the wizard"

test: ## Run vitest
	npx vitest run

e2e: ## Build and run all E2E tests
	$(BUILD)
	npx playwright test e2e/views-core.test.ts e2e/views-config.test.ts e2e/stress.test.ts
	npx tsx e2e/collect-coverage.ts

e2e-core: ## Build and run core views E2E (Overview, Trends, etc.)
	$(BUILD)
	npx playwright test e2e/views-core.test.ts
	npx tsx e2e/collect-coverage.ts

e2e-config: ## Build and run config views E2E (Sync, Dims, Scope)
	$(BUILD)
	npx playwright test e2e/views-config.test.ts
	npx tsx e2e/collect-coverage.ts

e2e-stress: ## Build and run widget growth stress tests
	$(BUILD)
	npx playwright test e2e/stress.test.ts

dist: ## Build distributable installer for current platform
	npm run build --workspaces
	npx --no-install electron-builder --publish never

dist-mac: ## Build macOS .dmg and .zip (current arch only)
	npm run build --workspaces
	npx --no-install electron-builder --mac --arm64 --publish never

dist-win: ## Build Windows .exe installer
	npm run build --workspaces
	npx --no-install electron-builder --win --publish never

dist-linux: ## Build Linux .AppImage and .deb
	npm run build --workspaces
	npx --no-install electron-builder --linux --publish never

release: ## Bump version (patch/minor/major), tag, and push to trigger release
	@echo "Current version: $$(node -p 'require("./package.json").version')"
	@echo ""
	@echo "  1) patch"
	@echo "  2) minor"
	@echo "  3) major"
	@echo ""
	@read -p "Select bump type [1/2/3]: " choice; \
	case $$choice in \
		1) bump=patch;; \
		2) bump=minor;; \
		3) bump=major;; \
		*) echo "Invalid choice"; exit 1;; \
	esac; \
	npm version $$bump --no-git-tag-version && \
	version=$$(node -p 'require("./package.json").version') && \
	cd packages/desktop && npm version $$version --no-git-tag-version && cd ../.. && \
	git add package.json package-lock.json packages/desktop/package.json && \
	git commit -m "Release v$$version" && \
	git tag "v$$version" && \
	echo "" && \
	echo "Tagged v$$version — push with:" && \
	echo "  git push origin main --tags"

perf: ## Build and run performance benchmarks
	$(BUILD)
	npx playwright test e2e/perf.test.ts

perf-queries: ## Build and run query performance diagnostics
	$(BUILD)
	npx playwright test e2e/perf-queries.test.ts

lint: ## Run tsc + eslint
	npx tsc --noEmit -p packages/core/tsconfig.json
	npx tsc --noEmit -p packages/ui/tsconfig.json
	npx tsc --noEmit -p packages/desktop/tsconfig.json
	npx eslint packages/*/src/

help: ## Show available commands
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
