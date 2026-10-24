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

make test           # unit tests + stdio/HTTP SQL integration tests (live API)
make test-semantic  # offline worker + reference semantic compiler acceptance tests
make test-stdio     # run test/sql/*.test against the bun stdio worker
make test-http      # boot a local HTTP server, run the suite against it, stop it
make test-cf        # run against the deployed Cloudflare Worker ($WORKER_CF)

make docker-build   # plain `bun install` build — no vendoring
make deploy         # fly deploy — NOT currently deployed anywhere, see below
make cf-deploy      # wrangler deploy (Cloudflare Worker, src/bin/cf.ts)
make cf-secret      # set the VGI_SIGNING_KEY state-token secret (once)
```

Metadata quality is linted with **`vgi-lint`** (`~/Development/vgi-lint-check`):
`uv run vgi-lint lint 'bun run /path/to/src/bin/worker.ts' --format agent`. The
worker documents itself for that linter via `vgi.*` tags on the catalog, schema,
and every function (doc_llm/doc_md, title, keywords, categories, result-column
schemas, agent_test_tasks, executable_examples) — see `catalog.ts`, the
`blockFunctionTags()` generator in `functions.ts`, and `resultColumnsSchema()` in
`schemas.ts`. Runnable examples live in each object's `vgi.example_queries` /
function `examples` (project columns, not `SELECT *`), never as a ```sql fence in
a description. Don't write "See the example queries." into a `doc_md` — VGI181
errors on that exact sentence as cross-worker boilerplate.

**Every function and macro advertises both example shapes.** A hardcoded
`(52.52, 13.41)` is what the API takes; a place name is what a person has, so
each object carries at least one example that opens with `geocoding(...)` and
LATERALs into the real function. `open_meteo_catalog.test` pins the count (22 =
16 functions + 6 macros) and fails if one loses its geocoded form. The block
generator emits two of them per endpoint (one place, then a column of places)
off `EndpointConfig.examplePlaces`, which defaults to Berlin/Tokyo — the marine
endpoints override it to Scheveningen/Brighton because a city centroid inland
geocodes to all-null waves. The `scheveningen_marine_by_name` /
`denver_elevation_by_name` agent tasks withhold coordinates on purpose, so the
analyst has to find the bridge.

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

-- positional args also accept COLUMNS, so name→coordinate→weather is one query:
SELECT p.city, w.temperature_2m
FROM (VALUES ('Berlin'), ('Tokyo')) AS p(city),
     LATERAL m.main.geocoding(p.city, count := 1) AS g,
     LATERAL m.main.forecast_current(g.latitude, g.longitude) AS w;
```

The catalog is named **`open_meteo`** — the first string in `ATTACH '<name>'`
must match it, or you get "No worker handles catalog '<name>'".

## Functions

There are **13 table functions + 6 scalar macros + 1 view (`weather_codes`)**:
every function requires `latitude`/`longitude` (or a `name`) as a *positional*
argument, so there's nothing to `SELECT * FROM table` without `()`. Optional args
(`timezone`, `forecast_days`, `temperature_unit`, …) are *named* (they have
defaults). Multi-location is a `LATERAL` join over a coordinates table (see
"Blended functions" below), not partitioning. `weather_codes` is a browsable, no-arg
view (the WMO 4677 table) — it satisfies the linter's "browsable relation" nudge
(VGI146), backs the `weather_code_*` macros, and JOINs to any `weather_code`
column. It's defined in `catalog.ts` as a `VALUES`-backed `ViewDescriptor`.

**Decoding macros (SQL ergonomics).** The functions return several raw coded
numbers; `src/macros.ts` adds catalog **macros** that translate them to labels:
`weather_code_text` / `weather_code_emoji` (WMO code), `wind_compass` (degrees →
16-point compass), `us_aqi_category` / `european_aqi_category` (AQI bands), and
`uv_index_category`. They're *macros*, not scalar functions, deliberately: DuckDB
expands a macro inline as SQL (zero RPC round-trips, no worker load) whereas a VGI
scalar function is an RPC per value. Call them schema-qualified, e.g.
`SELECT open_meteo.main.weather_code_text(weather_code) FROM open_meteo.main.forecast_current(52.52, 13.41)`.
They carry the same `vgi.*` docs as the functions and sit under the `helpers`
category; the (deterministic) macros are asserted in `open_meteo_catalog.test`.

**Blended functions: args can be columns.** All 13 are
`defineRowTransformFunction` ("blended" table-in-out), not `defineTableFunction`.
Their **positional args are per-row input columns**, so one registration serves
every call shape:

```sql
SELECT * FROM m.main.forecast_hourly(52.52, 13.41);              -- literal -> 1 input row
FROM cities, m.main.forecast_hourly(cities.lat, cities.lon);      -- columns -> streaming
FROM cities, LATERAL m.main.forecast_hourly(cities.lat, cities.lon);
```

So geocode→forecast is one query, and multi-location is a join rather than a
`UNION ALL` per site:

```sql
SELECT p.city, w.time, w.temperature_2m
FROM places p,
     LATERAL m.main.geocoding(p.city, count := 1) g,
     LATERAL m.main.forecast_current(g.latitude, g.longitude) w;
```

**Named args stay bind-time scalars** (`timezone`, `forecast_days`, units,
`models`) — they're on `params.args` and apply to the whole batch. Positional
args are read off the input `batch` in `process()`, never from `params.args`.
That split is what `buildArgSpec()` returns (`args` vs `namedArgs`).

This is DuckDB's rule, not ours: the table-in-out binder evaluates every named
parameter as a constant, so `timezone := g.timezone` fails with "does not
support lateral join column parameters". Don't "fix" it with a per-row
`timezone` — the need it seems to serve, each place bucketed in its own local
day, is already met by `timezone := 'auto'`, because Open-Meteo resolves `'auto'`
per location — even inside one multi-location request — from that row's
coordinates (`lateral.test` and `continuation.test` pin Tokyo 15Z / Reykjavik
0Z in one query). A trailing
positional `timezone` overload was built and rejected: the semantic model
refuses overloaded function names (`ambiguous_function_overload`, and tags are
entry-level so both overloads look like duplicate entity hosts), overloads go by
arity so they don't scale to a second per-row arg, and it's a no-op on
`forecast_current` (UTC instants, no buckets).

Four things the blended shape forces, all load-bearing in `functions.ts`:

1. **No finalize.** Map-shaped only — DuckDB forbids `FinalExecute` under
   correlated LATERAL. Everything is emitted from `process()`; there is no
   `out.finish()`.
2. **One emit per turn, carrying provenance.** A turn — an input batch, or a
   continuation tick — is answered by exactly one batch. These are 1→N (an
   hourly forecast is many rows per coordinate), so every emit passes
   `parentRowsMetadata(parentRows, …)` naming the input row behind each output
   row. Omit it and the extension assumes an identity 1→1 map and stamps outer
   columns from the wrong row — `test/sql/lateral.test` pins this by checking
   that `elevation`'s echoed coordinate matches its outer row. The weather
   functions answer one input batch with **several replies** (continued output,
   vgi ≥ 0.46): `process()` emits the first wrapped in
   `moreOutputMetadata(true, parentRowsMetadata(…))`, the client sends a
   zero-row CONTINUE tick, and the framework calls `resume()` for the next, until
   a reply goes out without "more". Every reply's parent rows index the *last
   real input*. `resume()` gets no batch, so the function's state
   (`WeatherPlan`, `src/multi-location.ts`) holds what it needs — the call's
   distinct locations, the input rows each serves, request boundaries, and the
   next request — and **never fetched rows**: over HTTP (Cloudflare, `serve.ts`)
   it rides every turn's state token. It is plain arrays of numbers/strings
   because the token serializer infers an Arrow schema from it (no `Map`s, no
   mixed-type arrays).
3. **`RowTransformConfig` has no `argConstraints` or `cardinality`.** The
   constraints still matter (they're how agents discover valid inputs via
   `vgi_function_arguments()`), so `withArgConstraints()` re-attaches them onto
   the built function's `argumentSpecs` with `constraintSpecFields`. The
   cardinality hints are simply gone — there is no blended equivalent.
4. **Upstream requests are multi-location; calls are bounded.** Every weather
   host takes comma-separated `latitude`/`longitude` lists and answers with a
   JSON array of per-location objects in request order (each but the first has
   `location_id`; a single coordinate gets a bare object — `splitLocations()`
   accepts both and throws on a length or `location_id` mismatch rather than
   misattribute). `planCall()` dedupes a call's rows to distinct locations (the
   key includes the per-row dates on archive/climate) and packs them, in order,
   into requests of at most **10 weighted API calls** (`callWeight`: Open-Meteo
   counts a location as `max(1, vars/10) × max(1, days/14)` calls), **100
   locations** and ~6 KB of coordinate text. A reply is **4 such requests
   fetched concurrently** (`REQUESTS_PER_REPLY`); "more" while requests remain.
   Each location's block is repeated for every input row it serves, so
   duplicate coordinates still get their own rows.

   Verified live (2026-10): array order = coordinate order on every host
   (forecast, archive, air-quality, marine, flood, climate, previous-runs,
   ensemble); `timezone=auto` resolves **per location** inside one request, so
   `lateral.test`'s Tokyo 15Z / Reykjavik 0Z still holds; archive and climate
   accept per-location `start_date`/`end_date` lists (ranges of different
   lengths), so rows with different required dates share a request; one invalid
   location (lat 95, end < start) fails the whole request with 400 — the query
   failed before too, when that row's own request did. Size: a 16-day,
   17-variable hourly forecast is ~34 KB JSON per location (100 locations →
   3.4 MB in ~3 s; 25 → 0.86 MB in ~1.5 s), which is why the budget is weight,
   not a location count.

   Why these numbers: multi-location saves round trips, **not quota** —
   Open-Meteo bills each location, so a reply of up to ~40 weighted calls is
   already 1/15 of the free tier's 600/minute; bigger replies would only reach
   the rate limit sooner. Replies of one call are sequential (each waits for a
   tick), so the concurrency lives inside a reply. On Cloudflare each reply is
   its own HTTP request, so a turn makes at most 4 subrequests — before, a
   2048-row chunk was 2048 subrequests in one invocation, past the Workers
   ceiling.

   **`inputRowsPerCall`** (`input_rows_per_call`, vgi ≥ 0.46) makes the
   extension's batched-LATERAL operator send each chunk's rows (after its dedup
   and per-value hits) as calls of at most N rows. Weather: **256**, which
   bounds the plan in the state token (~40 bytes/location) — the weather output
   isn't cached, so the call split costs nothing else. `elevation`: **100**
   (= `ELEVATION_BATCH`), so a call is one `/v1/elevation` request and one
   reply. `geocoding`: **8** (= `MAX_UPSTREAM_CONCURRENCY`), one concurrent wave
   of searches per call and one reply; per-value entries are then stored every
   8 names, and a turn makes ≤ 8 subrequests on Cloudflare. Neither elevation
   nor geocoding continues its output — **the extension stores no per-value
   entries for a call whose output continued** — so for a per-value-cached
   function, split with `inputRowsPerCall`, never with continuation.

   A LIMIT under batched LATERAL stops only *between chunks* (DuckDB drains a
   whole chunk under the delim join), so every reply of the current chunk's
   calls is still fetched; on a literal call one reply is all there is.

NULL coordinates (or NULL required dates) are dropped rather than sent — a 1→0
fan-out, which provenance expresses by never naming that input row.

`duckdb_functions().examples` carries the runnable
examples set on each function (the generator tailors them per endpoint: date
ranges, `forecast_days`/`past_days`, units, climate `models`). The rest of the
metadata **is** queryable — don't be fooled by the empty `.examples`/`.description`
columns on macros: the `vgi.*` docs (doc_llm/doc_md/example_queries/keywords/
category) surface in **`duckdb_functions().tags`**, and per-argument docs plus
the `choices`/`ge`/`le`/`pattern` constraints surface in **`vgi_function_arguments()`**
(`arg_description`, `arg_choices`, `arg_range`, `arg_pattern`) — for both the
table functions and the macros. Column comments surface via `duckdb_columns()` /
`DESCRIBE` as usual.

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
  the function accepts. This is the analog of the old `TripConfig`. The archive
  API uses a narrower hourly var set (`ARCHIVE_HOURLY`) — no
  visibility/uv_index/is_day, which the archive API 400s on.
- `src/schemas.ts` — `blockSchema(config)` builds a block function's Arrow
  schema (UTC `time`, calendar `date` for daily blocks, and typed weather variables);
  plus the static `GEOCODING_SCHEMA` and `ELEVATION_SCHEMA`. `field()` carries
  the `comment` metadata key DuckDB surfaces via `DESCRIBE`.
- `src/weather.ts` — `parseBlock()` zips a response block into name-keyed
  column arrays: parallel arrays for hourly/daily, scalars (one row) for
  `current`. See "Timestamps".
- `src/multi-location.ts` — the weather functions' multi-location planning:
  `planCall()` (dedup + pack a call's locations into weighted requests),
  `splitLocations()` (array/object response → per-location results, order
  checked), `callWeight()`, and the `WeatherPlan` continuation state. Pure, no
  vgi import; unit-tested in `test/unit/multi-location.test.ts`.
- `src/provenance.ts` — explicit provenance/interval columns shared by physical
  schemas and semantic dimensions; parses provider context without inventing
  model run times. `retrieved_at` comes from `omGetWithMetadata()` and survives
  worker-cache hits.
- `src/temporal.ts` — versioned `open_meteo.temporal` field-support definitions.
  The standard VGI member schema disallows extra temporal properties, so this
  is a separate function tag; the reference compiler does not enforce it.
- `src/functions.ts` — `defineWeatherFunction(config)` generates the 11 block
  functions; `geocoding` and `elevation` are defined directly. All read the API
  key via `apiKeyFromParams(params)`.
- `src/macros.ts` — `WEATHER_MACROS`, the 6 scalar decoding macros (WMO code,
  wind compass, AQI, UV) added to the `main` schema. Pure SQL `definition`
  strings; no runtime vgi import (type-only), so they add nothing to any bundle.
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
condition — no arrow-js reaches the edge (~718 KiB gzip bundle as of vgi 0.36 /
vgi-rpc 0.25.4; it grew from ~148 KiB with vgi-rpc 0.19, which statically inlines
the standardized landing page + browser client bundle into `handler.ts` — they
bundle whether or not the worker opts in via `landingInfo`). Before the first
real deploy, set the state-token key once: `make cf-secret` (random 32-byte hex →
`wrangler secret put VGI_SIGNING_KEY`); a stable key is **required** because
Workers isolates don't share memory, so a bind→scan query would otherwise fail
when it lands on a different isolate. `make test-cf` runs the full sqllogictest
suite against the deployment (`WORKER_CF`). Live at
`https://vgi-open-meteo.rusty-bb6.workers.dev` — **this is the only deployment**.
`fly.toml`, the `Dockerfile` and `make deploy` still work, but no Fly app exists
(there is no `vgi-open-meteo.fly.dev`; `make deploy` would create one, not update
one), so `serve.ts` is exercised only by `make serve` / `make test-http`.

CORS **defaults to `*`** as of vgi 0.27.0, so `cf.ts` passes
`corsOrigins: env.VGI_HTTP_CORS_ORIGINS` only to *narrow* it per-deployment;
leaving it unset is the correct open default, and `null` turns CORS off.

That default was fixed upstream rather than here. `createVgiFetch` used to treat
CORS as opt-in and emit no headers when the option was omitted, while
`serveVgiWorker` had always defaulted to `*` — so the two entries in the same
package disagreed and this Worker shipped with no `Access-Control` headers at
all. It is a failure only a third party can see: curl doesn't care, the suite
didn't care, and the landing page didn't care because it's same-origin. Cupola
did, being cross-origin, so the landing page's own "Explore" link pointed at a
UI this Worker refused to answer. Same shape as the `landingInfo` bug in
`cb18abe` — whatever `serveVgiWorker` derives for the Bun entry has to be passed
explicitly on the CF side, so the fix was to make the *default* right rather than
to remember one more option here.

The in-memory `omGet` cache is
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

Every block is fetched with `timeformat=unixtime`, and Open-Meteo's unixtime is
**true UTC regardless of `timezone`** — verified on every host we call. So
`unixToUtcMicros()` just scales seconds to `Timestamp(us, UTC)` micros, for
`time` and for timestamp-valued variables like `sunrise`/`sunset`. The
`timezone` arg controls where the window starts (local midnight) and how
*daily* aggregates are bucketed; it never moves the emitted instants.

Never subtract `utc_offset_seconds`. The worker used to, believing unixtime was
shifted into local time, which double-shifted every non-GMT timestamp — Tokyo's
day starting at 06:00Z and its sunrise at 11:28Z (20:28 local). `forecast.test`
pins the correct values (day start 15Z, sunrise 19–21Z) using `::TIMESTAMP`, a
core UTC cast; `epoch()`/`AT TIME ZONE` on a TIMESTAMPTZ need ICU, which the
test runner doesn't have.

## Caching

Two layers, and the important one is **not** the worker's.

**Client-side result cache (`vgi.cache.*`).** A function advertises cacheability
as metadata on its first emitted batch and the DuckDB extension caches the
result — no RPC, no worker CPU, and it survives across queries. `geocoding`
(`GEOCODING_CACHE`, 7d) and `elevation` (`ELEVATION_CACHE`, 30d) opt in, via
`cacheControlMetadata` from `vgi/worker-cf`, merged *over* `parentRowsMetadata`
so provenance survives. Both set `perValue`, which memoizes each distinct input
tuple — only meaningful for an exchange-mode MAP, i.e. a correlated `LATERAL`,
which is every call shape these blended functions have. The extension latches
the advertisement from an exchange's first output, so re-emitting it per batch
is harmless.

Per-value entries are stored **per call** — and only for a call whose output did
**not** continue (continued output is never cached: not per value, and not as a
whole chunk). That is why both cached functions split their work with
`inputRowsPerCall` (geocoding 8, elevation 100) and answer each call in exactly
one reply, while the uncached weather functions are the ones that continue.
`cache.test` pins it: ten names go out as calls of 8 and 2, 101 points as calls
of 100 and 1, and the repeat of each makes no worker call at all.

**The suite is rate-limit sensitive.** It runs against the live free tier
(600 weighted calls/minute per IP, and elevation counts every coordinate), so
running `test-stdio` and `test-http` back to back from one host can trip
HTTP 429. Every file sets `set ignore_error_messages` (empty), so a 429 —
like any transport error — fails the file instead of being silently skipped
(the sqllogictest runner's default skips errors that mention `HTTP`); rerun it
a minute later.

The two are not equally worth it. `geocoding` is one upstream call per distinct
name against a 600-calls/minute tier, so the memo is a large win; `elevation`
already batches 100 coordinates per call (one call = one request), so
`perValue` mostly buys the *repeat* query rather than within-batch dedup — kept because a DEM value is immutable and
the memo is therefore always safe.

The memo key is not just the input tuple: the extension folds
`canonical_arguments` and `attach_options` into the static key, so a
`count := 1` memo can't serve a `count := 5` call and a free-tier memo can't
serve an apikey'd one. `cache.test` pins both, and fails if the advertisement is
removed.

**The weather functions deliberately advertise nothing yet.** A relative `ttl`
is anchored to *receipt* while forecast data turns over at *model-issuance*
boundaries, so a window fetched just before a run lands serves a superseded
forecast for its full duration. Doing it right needs an absolute `expires` from
`https://<host>/data/<model>/static/meta.json` (undocumented, but live on every
weather host: `last_run_availability_time + update_interval_seconds`, plus ~10min
for Open-Meteo's eventual consistency) — clamped for overdue runs (observed:
HRRR 1.9h old on a 1h interval) and decommissioned models whose metadata has
gone stale (observed: `ecmwf_ifs04`, 18 months). `best_match` has no `meta.json`,
so it needs the minimum over candidate models. Geocoding needs none of this —
GeoNames is static, which is why its host serves no `meta.json`. See the
`TODO(result-cache)` on `defineWeatherFunction`.

**Worker-side `omGet` cache** (`open-meteo.ts`) is the weaker layer: an
unbounded `Map` keyed by resolved URL, per process — so it dies with the process
and is per-isolate on Cloudflare. A weather request's URL is the whole
multi-location group, so it hits only when the same group repeats (a re-run of
the same query, or a LIMIT'd chunk); duplicate coordinates *within* a call are
collapsed before any request by `planCall()` (and, under batched LATERAL,
already by the extension's input dedup). Note Open-Meteo returns
**no** `Cache-Control`/`ETag`/`Expires` on any endpoint, so every TTL here is
hand-calibrated, not negotiated.

## Testing

`test/sql/*.test` are DuckDB sqllogictest files, **transport-agnostic**: the
worker is injected via `VGI_OPEN_METEO_WORKER` (used as both the
`vgi_catalogs(...)` argument and the `ATTACH ... LOCATION`), so the same suite
runs against the stdio worker, a local HTTP server, or the deployed Cloudflare
Worker.

- `open_meteo_catalog.test` — catalog/function discovery, apikey option
  advertised, attach-with-key succeeds.
- `forecast.test` — forecast_hourly/daily/current column types + row counts +
  sane physical ranges.
- `geocoding.test` — geocoding search (incl. country filter) + elevation.
- `cache.test` — the `vgi.cache.*` advertisements: per-value memo stores then
  hits for `geocoding` and `elevation`, memo serves match upstream, `count`
  scoping isn't bypassed, and a memoized `elevation` still lands on the right
  outer row.
- `continuation.test` — multi-location requests answered as continued output:
  40 points in one call need more than one reply (counted with the
  `table_in_out.continue` / `table_in_out.write_input` events in
  `duckdb_logs`), row-for-row equivalence with `SET vgi_batch_lateral = false`
  (one single-location request per row), per-location `timezone := 'auto'`,
  per-row archive dates in one request, and LIMIT. Needs an extension with
  continuation (vgi 2.2 protocol); `threads = 1` keeps the call count exact.
- `lateral.test` — the blended call shapes: column args, `LATERAL`, comma join,
  the one-query geocode→forecast bridge, NULL coordinates as 1→0, and
  per-output-row provenance (asserted via `elevation` echoing its input
  coordinate back next to the outer row).

They run under DuckDB's `unittest` runner, which must be a build with the `vgi`
and `httpfs` extensions statically linked — `make` defaults `TEST_RUNNER` to
`~/Development/vgi/build/release/test/unittest`. Override `TEST_RUNNER` if yours
lives elsewhere. The tests hit the **live Open-Meteo API**, so they need network
access. `test-cf` hits the deployment, which runs open (no auth configured), so
no token is needed.

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

## Curated semantic model

`src/semantic.ts` explicitly defines the everyday-weather vocabulary. Do not
regenerate members or average measures from endpoint schemas or variable-name
patterns. Shared helpers serialize the contract and share explicitly chosen
concepts. The allowlist covers current/hourly/daily forecasts, hourly/daily
history, current/hourly air quality, geocoding, elevation and weather codes.
Specialist endpoints remain SQL-only.

Forecast/current and historical functions accept one `model` selector (default
`best_match`); it maps to upstream `models`. Reject lists because multiple
upstream models rename columns and invalidate the fixed schema. Specialist
functions retain their existing plural `models` option. `model_selection` is
requested selection provenance, not resolved per-variable attribution. Never
derive model-run/issue/lead times from retrieval time or model-update status.
No unique run is supplied by these regular response APIs.

Every physical output of a modeled function must have a visible member with
the same identifier and SQL type, a readable title, and a reviewed definition.
Simplify aggregate measures, not field availability. Forecast and archive rain
have different meanings. Snowfall depth uses cm in metric mode, precipitation
water equivalent uses mm; both use inches in imperial mode. Hourly irradiance
(W/m²) and daily radiant energy (MJ/m²) are different quantities. Coverage counts
must identify the variable counted; daily temperature coverage requires both
extremes. Do not average directions, category codes or daily highs/lows into a
supposed mean temperature. Sources are linked in README.md.

Forecast dew point follows temperature units; precipitation probability remains
percent with either precipitation-unit setting. Only maximum hourly probability
is a supported probability summary; it is not a period event probability.
The probability threshold is nominal (0.1 mm/hour), with source-native and
interpolation caveats. Do not encode a universal exact threshold comparison.

Every modeled weather variable needs an explicit `open_meteo.temporal` entry.
Keep instantaneous values, preceding intervals, provider days, event times and
source-dependent support distinct. Hourly bounds end at `time`; daily bounds
start at `time`; current bounds use actual `current.interval` or remain NULL.
Do not apply accumulation windows to instantaneous fields, archive/current
gusts, UV or pollutant-specific AQI windows. Bounds describe reporting support,
not native model resolution. Unknown metadata stays unknown.

Daily functions default to `timezone := 'auto'` where supported. Their `date`
column is Arrow date32, computed from the daily interval's Unix timestamp plus
Open-Meteo's response `utc_offset_seconds`. That offset is for the calendar label
only: never shift `time`, sunrise or sunset. Missing offsets produce NULL dates.
The provider holds one fixed offset across a response, so these intervals may
not match civil days across a DST transition.
The semantic daily date is a plain calendar dimension; hourly time rollups use
UTC. Period totals and extrema are explicit measures, and weather descriptions
come through optional to-one WMO relationships.

`bun run test` runs the offline unit suite in CI. `make test-semantic` uses
`VGI_LINT_PROJECT` (default `~/Development/vgi-lint-check`) for the reference
compiler and haybarn. It attaches the real worker with a fixture-only fetch
implementation and verifies selection of every modeled weather field, units,
daily dates, independent missing values, condition joins and existing-table
bindings with distinct sites sharing coordinates. Semantic bindings omit null
coordinates; SQL LEFT JOIN LATERAL can retain those rows. No Open-Meteo calls
are made.
