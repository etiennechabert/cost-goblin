.PHONY: dev reset test lint

dev:
	cd packages/desktop && npm run dev

reset:
	rm -rf "$(HOME)/Library/Application Support/@costgoblin"
	@echo "Cleared app data and config — next launch will show the wizard"

test:
	npx vitest run

lint:
	npx tsc --noEmit -p packages/core/tsconfig.json
	npx tsc --noEmit -p packages/ui/tsconfig.json
	npx tsc --noEmit -p packages/desktop/tsconfig.json
	npx eslint packages/*/src/
