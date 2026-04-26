.PHONY: dev prod reset test e2e e2e-core e2e-config e2e-stress perf lint help
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

perf: ## Build and run performance benchmarks
	$(BUILD)
	npx playwright test e2e/perf.test.ts

lint: ## Run tsc + eslint
	npx tsc --noEmit -p packages/core/tsconfig.json
	npx tsc --noEmit -p packages/ui/tsconfig.json
	npx tsc --noEmit -p packages/desktop/tsconfig.json
	npx eslint packages/*/src/

help: ## Show available commands
	@grep -E '^[a-zA-Z0-9_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
