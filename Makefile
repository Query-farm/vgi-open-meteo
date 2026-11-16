SHELL := /bin/bash

.PHONY: install typecheck worker serve docker-build deploy \
        cf-dev cf-deploy cf-secret test-cf tools check test-sql-live \
        test test-unit test-semantic test-sql test-sql-all

install:
	bun install

typecheck:
	bunx tsc -p tsconfig.json --noEmit

# ---------------------------------------------------------------------------
# SQL integration tests (sqllogictest) through the published haybarn-unittest
# runner and the signed community vgi extension, as in the vgi-starter
# template: ci/run-integration.sh runs test/sql/*.test over one transport
# (stdio | launch | http) against ci/worker. VGI_OPEN_METEO_WORKER is the
# ATTACH LOCATION. Files that hit the live Open-Meteo API carry
# `require-env OPEN_METEO_LIVE` and skip unless it is set (make test-sql-live),
# so the default suite is offline and deterministic.
# ---------------------------------------------------------------------------
HAYBARN_VERSION  ?= 2.0.0rc11
TOOLS            := $(CURDIR)/.tools
HAYBARN_UNITTEST := $(TOOLS)/bin/haybarn-unittest
WORKER           := $(CURDIR)/ci/worker
TRANSPORT        ?= stdio
EXPECTED_SKIP_REASONS ?= require-env OPEN_METEO_LIVE
WORKER_CF        ?= https://vgi-open-meteo.rusty-bb6.workers.dev

# Default suite uses the local transports; test-cf hits the live deployment.
test: test-unit test-sql-all

check: typecheck test-unit test-sql-all

test-unit:
	bun run test

# Offline semantic acceptance tests use the reference compiler and its haybarn
# runtime. Override this path when the vgi-lint-check checkout lives elsewhere.
VGI_LINT_PROJECT ?= $(HOME)/Development/vgi-lint-check
test-semantic:
	uv run --project "$(VGI_LINT_PROJECT)" python test/semantic/queries.py

# Install the pinned SQL test runner into .tools.
tools:
	@test -x $(HAYBARN_UNITTEST) || { uv venv -q $(TOOLS) && uv pip install -q -p $(TOOLS) haybarn-unittest==$(HAYBARN_VERSION); }

# make test-sql TRANSPORT=stdio|launch|http
test-sql: install tools
	WORKER=$(WORKER) HAYBARN_UNITTEST=$(HAYBARN_UNITTEST) TRANSPORT=$(TRANSPORT) EXPECTED_SKIP_REASONS="$(EXPECTED_SKIP_REASONS)" ci/run-integration.sh

test-sql-all:
	$(MAKE) test-sql TRANSPORT=stdio
	$(MAKE) test-sql TRANSPORT=launch
	$(MAKE) test-sql TRANSPORT=http

# The full suite including the live Open-Meteo files (one transport; rerun a
# minute later on HTTP 429). make test-sql-live TRANSPORT=http
test-sql-live:
	OPEN_METEO_LIVE=1 $(MAKE) test-sql

# Run the suite against the deployed Cloudflare Worker (the .test files LOAD
# vgi and httpfs themselves; run test-sql once first to install them).
test-cf: tools
	OPEN_METEO_LIVE=1 VGI_OPEN_METEO_WORKER="$(WORKER_CF)" $(HAYBARN_UNITTEST) --keep-home --test-dir $(CURDIR) "test/sql/*"

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
