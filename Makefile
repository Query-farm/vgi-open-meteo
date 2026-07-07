SHELL := /bin/bash

.PHONY: install typecheck worker serve docker-build deploy \
        cf-dev cf-deploy cf-secret test-cf \
        test test-stdio test-http test-cloud

install:
	bun install

typecheck:
	bunx tsc -p tsconfig.json --noEmit

# ---------------------------------------------------------------------------
# SQL integration tests (sqllogictest). The .test files in test/sql/ are
# transport-agnostic: VGI_OPEN_METEO_WORKER is the ATTACH LOCATION — a stdio
# command, a local HTTP URL, or the deployed Fly URL. Run them with DuckDB's
# unittest runner (a build with the vgi + httpfs extensions statically linked).
# ---------------------------------------------------------------------------
TEST_RUNNER  ?= $(HOME)/Development/vgi/build/release/test/unittest
TEST_PATTERN ?= test/sql/*
HTTP_PORT    ?= 8000
WORKER_STDIO ?= bun run $(CURDIR)/src/bin/worker.ts
WORKER_HTTP  ?= http://localhost:$(HTTP_PORT)
WORKER_CLOUD ?= https://vgi-open-meteo.fly.dev
WORKER_CF    ?= https://vgi-open-meteo.rusty-bb6.workers.dev

# Default suite uses the local transports. test-cloud hits the deployed app
# (auth is currently disabled in fly.toml, so no Bearer token is needed).
test: test-stdio test-http

test-stdio:
	VGI_OPEN_METEO_WORKER="$(WORKER_STDIO)" $(TEST_RUNNER) --test-dir $(CURDIR) "$(TEST_PATTERN)"

# Boots a local HTTP server on $(HTTP_PORT), runs the suite against it, stops it.
test-http:
	@VGI_SIGNING_KEY=dev VGI_HTTP_PORT=$(HTTP_PORT) bun run src/bin/serve.ts & \
		SERVER_PID=$$!; \
		for i in $$(seq 1 20); do curl -fsS http://localhost:$(HTTP_PORT)/health >/dev/null 2>&1 && break; sleep 0.5; done; \
		VGI_OPEN_METEO_WORKER="$(WORKER_HTTP)" $(TEST_RUNNER) --test-dir $(CURDIR) "$(TEST_PATTERN)"; \
		TEST_EXIT=$$?; \
		kill $$SERVER_PID 2>/dev/null; wait $$SERVER_PID 2>/dev/null; \
		exit $$TEST_EXIT

test-cloud:
	VGI_OPEN_METEO_WORKER="$(WORKER_CLOUD)" $(TEST_RUNNER) --test-dir $(CURDIR) "$(TEST_PATTERN)"

# Run the suite against the deployed Cloudflare Worker.
test-cf:
	VGI_OPEN_METEO_WORKER="$(WORKER_CF)" $(TEST_RUNNER) --test-dir $(CURDIR) "$(TEST_PATTERN)"

# Run the worker on stdin/stdout (for DuckDB ATTACH ... TYPE vgi, LOCATION 'bun run src/bin/worker.ts')
worker:
	bun run src/bin/worker.ts

# Run the HTTP server (for DuckDB ATTACH 'http://localhost:8000/vgi' TYPE vgi)
serve:
	VGI_SIGNING_KEY=$${VGI_SIGNING_KEY:-dev} bun run src/bin/serve.ts

# Dependencies come from npm (@query-farm/vgi, @query-farm/vgi-rpc), so the
# Docker build is a plain `bun install` — no sibling vendoring step.
GIT_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
docker-build:
	docker build --build-arg GIT_COMMIT=$(GIT_COMMIT) -t vgi-open-meteo .

deploy:
	flyctl deploy --build-arg GIT_COMMIT=$(GIT_COMMIT)

# ---------------------------------------------------------------------------
# Cloudflare Workers deploy (src/bin/cf.ts + wrangler.toml). The flechette Arrow
# backend is selected automatically by the workerd export condition. Set the
# state-token key once with `make cf-secret` before the first real deploy.
# ---------------------------------------------------------------------------
cf-dev:
	bunx wrangler dev

cf-deploy:
	bunx wrangler deploy

cf-secret:
	@openssl rand -hex 32 | bunx wrangler secret put VGI_SIGNING_KEY
