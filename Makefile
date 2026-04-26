.PHONY: dev prod reset test e2e perf lint help
.DEFAULT_GOAL := help

dev: ## Launch Electron in dev mode
	cd packages/desktop && npm run dev

prod: ## Build and launch Electron in production mode
	npm run build --workspace=packages/desktop
	npx electron packages/desktop/out/main/main.js

reset: ## Wipe app data and config — next launch shows wizard
	rm -rf "$(HOME)/Library/Application Support/@costgoblin"
	@echo "Cleared app data and config — next launch will show the wizard"

test: ## Run vitest
	npx vitest run

e2e: ## Build the app and run E2E tests
	npm run build --workspace=packages/desktop
	npx playwright test e2e/app.test.ts

perf: ## Build the app and run performance benchmarks
	npm run build --workspace=packages/desktop
	npx playwright test e2e/perf.test.ts

lint: ## Run tsc + eslint
	npx tsc --noEmit -p packages/core/tsconfig.json
	npx tsc --noEmit -p packages/ui/tsconfig.json
	npx tsc --noEmit -p packages/desktop/tsconfig.json
	npx eslint packages/*/src/

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
