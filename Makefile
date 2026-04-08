.PHONY: dev reset check

dev:
	cd packages/desktop && npm run dev

reset:
	rm -rf "$(HOME)/Library/Application Support/@costgoblin"
	@echo "Cleared app data and config — next launch will show the wizard"

check:
	npm run check
