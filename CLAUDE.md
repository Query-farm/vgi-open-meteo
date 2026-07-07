# CLAUDE.md

A TypeScript VGI worker that exposes the **Open-Meteo** weather API family as
queryable table functions for DuckDB. Built on the framework published to npm as
**`@query-farm/vgi`** (+ `@query-farm/vgi-rpc`); `package.json` aliases them to
the bare `vgi` / `vgi-rpc` import specifiers via `npm:` so the source imports
stay short. Adapted from `vgi-trains-ts` (the NS Dutch railway port), so the
architecture — stdio worker + stateless HTTP server, `defineTableFunction`,
Arrow schemas, sqllogictest suite, Fly/Docker deploy — is shared; only the data
domain changed.

## Quick reference

```bash
make install        # bun install
make typecheck      # bunx tsc --noEmit
make worker         # stdio worker (for DuckDB ATTACH ... TYPE vgi, LOCATION 'bun run ...')
make serve          # HTTP server on $VGI_HTTP_PORT (default 8000)

make test           # test-stdio + test-http (sqllogictest, 79 assertions, live API)
make test-stdio     # run test/sql/*.test against the bun stdio worker
make test-http      # boot a local HTTP server, run the suite against it, stop it
make test-cloud     # run against https://vgi-open-meteo.fly.dev (auth disabled → open)
make test-cf        # run against the deployed Cloudflare Worker ($WORKER_CF)

make docker-build   # plain `bun install` build — no vendoring
make deploy         # fly deploy
make cf-deploy      # wrangler deploy (Cloudflare Worker, src/bin/cf.ts)
make cf-secret      # set the VGI_SIGNING_KEY state-token secret (once)
```

Metadata quality is linted with **`vgi-lint`** (`~/Development/vgi-lint-check`):
`uv run vgi-lint lint 'bun run /path/to/src/bin/worker.ts' --format agent`. The
worker documents itself for that linter via `vgi.*` tags on the catalog, schema,
and every function (doc_llm/doc_md, title, keywords, categories, result-column
tables, agent_test_tasks, executable_examples) — see `catalog.ts`, the
`blockFunctionTags()` generator in `functions.ts`, and `resultColumnsMd()` in
`schemas.ts`.

DuckDB attach examples:

```sql
-- stdio (worker as subprocess)
ATTACH 'open_meteo' AS m
  (TYPE vgi, LOCATION 'bun run /path/to/vgi-open-meteo/src/bin/worker.ts');

-- HTTP
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'http://localhost:8000');

-- Commercial tier: supply the API key as an ATTACH option (see "Attach options")
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION '...', apikey 'YOUR_KEY');

-- latitude/longitude are REQUIRED positional args; options are named:
SELECT time, temperature_2m FROM m.main.forecast_hourly(52.52, 13.41) LIMIT 5;
SELECT * FROM m.main.forecast_current(52.52, 13.41);
SELECT * FROM m.main.forecast_daily(52.52, 13.41, forecast_days := 14, timezone := 'auto');

-- geocoding is the name→coordinate bridge (name is positional):
SELECT name, latitude, longitude FROM m.main.geocoding('Berlin', count := 5);
SELECT * FROM m.main.elevation(52.52, 13.41);
```

The catalog is named **`open_meteo`** — the first string in `ATTACH '<name>'`
must match it, or you get "No worker handles catalog '<name>'".

## Functions

There are **13 table functions, no catalog tables**: every function requires
`latitude`/`longitude` (or a `name`) as a *positional* argument, so there's
nothing to `SELECT * FROM table` without `()`. Optional args (`timezone`,
`forecast_days`, `temperature_unit`, …) are *named* (they have defaults).
Multi-location is done in SQL (`UNION ALL` / cross join over a coordinates
table), not via partitioning.

**Args must be literals.** VGI table functions only accept literal arguments —
DuckDB rejects correlated/`LATERAL` column references ("does not support lateral
join column parameters"). So the geocode→forecast bridge is a two-step (read the
coordinates from `geocoding(...)`, then call `forecast_*` with those numbers),
not a single correlated join. `duckdb_functions().examples` carries runnable
examples for every function (the generator tailors them per endpoint: date
ranges, `forecast_days`/`past_days`, units, climate `models`); `argDocs` and
column comments are set but do **not** surface through DuckDB's
`duckdb_functions()` / `DESCRIBE` in current builds.

Eleven are **"block" functions** generated from one config table; two are
bespoke:

| Function | Host | Block |
|---|---|---|
| `forecast_hourly` / `forecast_daily` / `forecast_current` | api.open-meteo.com `/v1/forecast` | hourly/daily/current |
| `historical_hourly` / `historical_daily` | archive-api.open-meteo.com `/v1/archive` | needs `start_date`,`end_date` |
| `air_quality_hourly` / `air_quality_current` | air-quality-api.open-meteo.com `/v1/air-quality` | pollutants + AQI |
| `marine_hourly` / `marine_daily` | marine-api.open-meteo.com `/v1/marine` | wave/swell |
| `flood_daily` | flood-api.open-meteo.com `/v1/flood` | river discharge |
| `climate_daily` | climate-api.open-meteo.com `/v1/climate` | needs `start_date`,`end_date`,`models` |
| `geocoding` | geocoding-api.open-meteo.com `/v1/search` | place name → coords (search table) |
| `elevation` | api.open-meteo.com `/v1/elevation` | terrain elevation, 1 row |

**Not ported:** ensemble / seasonal / satellite endpoints — ensemble returns
per-member dynamic columns that don't fit a static Arrow schema.

## Architecture

- `src/open-meteo.ts` — HTTP client. `omGet(host, path, query, {apikey, ttlMs})`
  builds the URL, fetches JSON, caches per resolved-URL with a per-call TTL.
  When `apikey` is set it rewrites the host to the `customer-` prefix
  (`api.` → `customer-api.`, `archive-api.` → `customer-archive-api.`, …) **and**
  appends `&apikey=` — both are required together for the commercial tier.
- `src/endpoints.ts` — `EndpointConfig` records: host, path, block kind, the
  **curated fixed variable list** (`WeatherVar` = name + `kind`), and which args
  the function accepts. This is the analog of the old `TripConfig`. Archive
  (ERA5) uses a narrower hourly var set (`ARCHIVE_HOURLY`) — no
  visibility/uv_index/is_day, which the archive API 400s on.
- `src/schemas.ts` — `blockSchema(config)` builds a block function's Arrow
  schema (UTC `time` column + one column per variable, typed from its `kind`);
  plus the static `GEOCODING_SCHEMA` and `ELEVATION_SCHEMA`. `field()` carries
  the `comment` metadata key DuckDB surfaces via `DESCRIBE`.
- `src/weather.ts` — `parseBlock()` zips a response block into name-keyed
  column arrays: parallel arrays for hourly/daily, scalars (one row) for
  `current`. See "Timestamps".
- `src/functions.ts` — `defineWeatherFunction(config)` generates the 11 block
  functions; `geocoding` and `elevation` are defined directly. All read the API
  key via `apiKeyFromParams(params)`.
- `src/catalog.ts` — the `open_meteo` `CatalogDescriptor` plus `OpenMeteoCatalog`
  (the catalog interface subclass that advertises + plumbs the apikey option —
  see below) and `buildRegistry()`.
- `src/bin/worker.ts` — stdio + AF_UNIX launcher entry. Uses
  `catalogInterfaceFactory: () => new OpenMeteoCatalog(...)` so the apikey option
  is advertised (a plain `new Worker({catalog})` would use the stock
  `ReadOnlyCatalogInterface` and *not* advertise it).
- `src/bin/serve.ts` — Bun HTTP server entry (Fly/Cloud Run). Constructs
  `OpenMeteoCatalog` directly. State tokens are XChaCha20-Poly1305 AEAD-sealed
  with the key derived from `VGI_SIGNING_KEY`. Serves `/health`. Optional
  JWT/OAuth auth is unchanged from the trains port (`src/auth.ts`).
- `src/bin/cf.ts` — Cloudflare Workers entry (`export default { fetch }` via
  `createVgiFetch` from `vgi/worker-cf`). Same catalog/registry; state tokens are
  keyed off the `VGI_SIGNING_KEY` **secret** (`wrangler secret put`). See
  "Cloudflare Workers" below.

**Backend-agnostic Arrow (load-bearing for the CF build).** The shared modules
(`schemas.ts`, `functions.ts`, `attach-options.ts`, `catalog.ts`) build Arrow
schemas/types through vgi's portable factories (`schema`, `field`, `float64`,
`int32`, `timestamp`, …) imported from **`vgi/worker-cf`**, never from
`@query-farm/apache-arrow` directly. Two reasons: (1) on workerd vgi swaps in the
flechette backend, so apache-arrow objects wouldn't match; (2) the package root
(`"vgi"`) re-exports the Node-only stdio `Worker` (→ `serveUnix`/`serveTcp`, absent
from vgi-rpc's workerd build), which breaks the Cloudflare bundle — `vgi/worker-cf`
is the workerd-safe facade and behaves identically on Bun. Type-only imports
(`ArgumentConstraints`) can still come from `"vgi"` (erased at build). Any
`process.env` reads must be guarded (`globalThis.process?.env?…`) since workerd
has no `process`.

## Cloudflare Workers

`make cf-deploy` (= `wrangler deploy`) ships `src/bin/cf.ts` per `wrangler.toml`.
The flechette Arrow backend is selected automatically by the `workerd` export
condition — no arrow-js reaches the edge (~148 KiB gzip bundle). Before the first
real deploy, set the state-token key once: `make cf-secret` (random 32-byte hex →
`wrangler secret put VGI_SIGNING_KEY`); a stable key is **required** because
Workers isolates don't share memory, so a bind→scan query would otherwise fail
when it lands on a different isolate. `make test-cf` runs the full sqllogictest
suite against the deployment (`WORKER_CF`). Live at
`https://vgi-open-meteo.rusty-bb6.workers.dev`. The in-memory `omGet` cache is
per-isolate/ephemeral on CF (correct, just lower hit-rate); back it with the CF
Cache API if cross-request caching matters.

## Attach options (the API key)

`open_meteo` advertises one optional ATTACH option, `apikey` (Utf8, default
`""`), so commercial customers authenticate at attach time. The mechanism
mirrors vgi-typescript's `examples/attach-options-worker.ts`:

1. `src/attach-options.ts` declares `ATTACH_OPTION_SPECS` and the
   encode/decode helpers (UUID + `0x00` separator + a 1-row IPC batch).
2. `OpenMeteoCatalog` overrides `catalogsInfo()` to advertise
   `serializeAttachOptionSpecs(ATTACH_OPTION_SPECS)`, and `attach()` to encode
   the received options into `attach_opaque_data`.
3. Each function calls `apiKeyFromParams(params)`, which decodes
   `params.initCall.bind_call.attach_opaque_data`. **Decoding is lenient**: a
   missing/short payload (free-tier attach with no key) yields `{}` → no key →
   free host. A non-empty key → commercial host.

`vgi_catalogs('<location>')` surfaces the advertised option in its
`attach_options` column — `open_meteo_catalog.test` asserts this.

**Gotcha:** once a key is set, *every* request routes to a `customer-*` host
that validates it. So you cannot mix a (dummy) key with free queries — the
commercial endpoint returns HTTP 400 "The supplied API key is invalid." The
apikey test therefore only asserts that ATTACH-with-key *succeeds*; it never
runs a weather query under a fake key.

## Timestamps

Every block is fetched with `timeformat=unixtime`. Open-Meteo shifts unixtime by
the response's `utc_offset_seconds` whenever a `timezone` is set, so
`unixToUtcMicros()` subtracts the offset to recover true UTC before emitting
`Timestamp(us, UTC)` micros. This applies to `time` and to timestamp-valued
variables like `sunrise`/`sunset`. The `timezone` arg still controls how *daily*
aggregates are bucketed; the emitted instants are always UTC.

## Testing

`test/sql/*.test` are DuckDB sqllogictest files, **transport-agnostic**: the
worker is injected via `VGI_OPEN_METEO_WORKER` (used as both the
`vgi_catalogs(...)` argument and the `ATTACH ... LOCATION`), so the same suite
runs against the stdio worker, a local HTTP server, or the deployed Fly app.

- `open_meteo_catalog.test` — catalog/function discovery, apikey option
  advertised, attach-with-key succeeds.
- `forecast.test` — forecast_hourly/daily/current column types + row counts +
  sane physical ranges.
- `geocoding.test` — geocoding search (incl. country filter) + elevation.

They run under DuckDB's `unittest` runner, which must be a build with the `vgi`
and `httpfs` extensions statically linked — `make` defaults `TEST_RUNNER` to
`~/Development/vgi/build/release/test/unittest`. Override `TEST_RUNNER` if yours
lives elsewhere. The tests hit the **live Open-Meteo API**, so they need network
access. `test-cloud` hits the deployment (auth disabled — see fly.toml — so it
runs open, no token needed).

## arrow-js single-copy (npm deps)

arrow-js uses an `instanceof`-based visitor for type serialization, so two copies
of `@query-farm/apache-arrow` at runtime = two `Float64` classes = the visitor's
`visitFloat` doesn't dispatch, `precision` is dropped, and DuckDB errors
"Unsupported Internal Arrow Type e". With everything installed from npm this is
handled by ordinary hoisting: `@query-farm/vgi` declares `@query-farm/apache-arrow`
as a **peer dependency** and `@query-farm/vgi-rpc` as a regular one, and this
worker pins the same `^21.1.1`, so bun hoists a **single** copy that all three
resolve. No symlink/postinstall hack is needed anymore (the former
`scripts/postinstall.cjs` was removed with the npm migration). If you ever see
the "Unsupported Internal Arrow Type" error again, check for a duplicated
`@query-farm/apache-arrow` under `node_modules` (`find node_modules -name apache-arrow -type d`).

## Environment variables (HTTP server)

- `VGI_HTTP_PORT` / `PORT` (default 8000), `VGI_HTTP_HOST` (default `0.0.0.0`),
  `VGI_HTTP_PREFIX` (default empty), `VGI_HTTP_CORS_ORIGINS`.
- `VGI_SIGNING_KEY` — stable string, SHA-256'd to the 32-byte
  XChaCha20-Poly1305 key sealing state tokens. Required in production; unset =
  random ephemeral key (state tokens won't survive a restart).
- `VGI_TOKEN_TTL` (default 3600s), `VGI_OPEN_METEO_GIT_COMMIT` (catalog metadata).
- Optional auth (unchanged from the trains port): `VGI_JWT_ISSUER` +
  `VGI_JWT_AUDIENCE` (+ `VGI_JWT_JWKS_URI`) gate every RPC; `VGI_OAUTH_*` enable
  RFC 9728 Protected Resource Metadata + the PKCE browser flow. Unset = open.
  Non-secret values live in `fly.toml [env]`; client secrets are Fly secrets.

## What's not ported (from the original)

- **Sentry** — add `@sentry/bun` + `Sentry.init()` in `src/bin/serve.ts` if wanted.
- **Catalog version advertising** — `attach()` hardcodes
  `resolved_implementation_version`/`resolved_data_version` to null; wiring
  `DATA_VERSION`/`GIT_COMMIT` through needs framework support.
