.PHONY: dev reset test lint help
.DEFAULT_GOAL := help

dev: ## Launch Electron in dev mode
	cd packages/desktop && npm run dev

reset: ## Wipe app data and config — next launch shows wizard
	rm -rf "$(HOME)/Library/Application Support/@costgoblin"
	@echo "Cleared app data and config — next launch will show the wizard"

test: ## Run vitest
	npx vitest run

lint: ## Run tsc + eslint
	npx tsc --noEmit -p packages/core/tsconfig.json
	npx tsc --noEmit -p packages/ui/tsconfig.json
	npx tsc --noEmit -p packages/desktop/tsconfig.json
	npx eslint packages/*/src/

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
