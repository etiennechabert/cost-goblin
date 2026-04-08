.PHONY: dev reset check test

dev:
	cd packages/desktop && npm run dev

reset:
	rm -rf "$(HOME)/Library/Application Support/@costgoblin"
	@echo "Cleared app data and config — next launch will show the wizard"

test:
	npx vitest run

check:
	npm run check
