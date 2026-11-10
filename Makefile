COMPOSE = docker compose
# --build: one-off commands always use the current code, not a stale image
RUN = $(COMPOSE) run --build --rm

.PHONY: deploy restart stop logs status dry-run preview once auth brightspace-report eval report test vps-audit

deploy: .env ## Build and (re)start the worker. Safe to run again after any change.
	@mkdir -p reports && (chown 1000:1000 reports 2>/dev/null || true)
	$(COMPOSE) up -d --build --remove-orphans
	@$(COMPOSE) ps

restart: ## Pick up edited prompts or config without rebuilding
	$(COMPOSE) restart worker

stop:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f --tail=100 worker

status:
	@$(COMPOSE) ps

preview: .env ## What would be sent to the AI. Sends nothing. Output: reports/preview-*.md
	@mkdir -p reports && (chown 1000:1000 reports 2>/dev/null || true)
	$(RUN) -e MODE=preview worker node dist/index.js once

dry-run: .env ## Calls the AI, creates nothing. Output: reports/dry-run-*.md
	@mkdir -p reports && (chown 1000:1000 reports 2>/dev/null || true)
	$(RUN) -e MODE=dry-run worker node dist/index.js once

once: .env ## One run in whatever MODE .env says
	$(RUN) worker node dist/index.js once

auth: .env ## Connect a Gmail inbox. Run inside an SSH tunnel; see README.
	$(RUN) -p 127.0.0.1:53682:53682 worker node dist/index.js auth

brightspace-report: .env ## What the Brightspace feed contains, with links scrubbed
	@mkdir -p reports && (chown 1000:1000 reports 2>/dev/null || true)
	$(RUN) worker node dist/index.js brightspace-report

eval: .env ## Precision and recall on the 30 fixture emails. Calls the AI (a few cents).
	$(RUN) worker node dist/index.js eval

report: ## Show the newest dry-run report
	@ls -t reports/dry-run-*.md 2>/dev/null | head -1 | xargs -r cat

test: ## Unit tests (needs Node 22 on this machine)
	cd worker && npm ci && npm test

vps-audit: ## Read-only look at the server's security settings. Changes nothing.
	@bash scripts/vps-audit.sh

.env:
	@echo "No .env yet. Run: cp .env.example .env   then fill it in." && exit 1
