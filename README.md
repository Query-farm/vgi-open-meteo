<p align="center">
  <img src="assets/vgi-logo.png" alt="Vector Gateway Interface" width="320">
</p>

<h1 align="center">vgi-open-meteo</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@query-farm/vgi-open-meteo"><img alt="npm" src="https://img.shields.io/npm/v/@query-farm/vgi-open-meteo?logo=npm&color=CB3837"></a>
  <a href="https://github.com/Query-farm/vgi-open-meteo/pkgs/container/vgi-open-meteo"><img alt="Container image" src="https://img.shields.io/badge/ghcr.io-image-2496ED?logo=docker&logoColor=white"></a>
  <a href="https://open-meteo.com"><img alt="Data: Open-Meteo" src="https://img.shields.io/badge/data-Open--Meteo-0A9396"></a>
  <a href="https://github.com/Query-farm"><img alt="DuckDB: VGI extension" src="https://img.shields.io/badge/DuckDB-VGI%20extension-FFF000?logo=duckdb&logoColor=black"></a>
  <a href="https://vgi-open-meteo.rusty-bb6.workers.dev"><img alt="Live on Cloudflare Workers" src="https://img.shields.io/badge/live-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white"></a>
  <img alt="vgi-lint score 100/100" src="https://img.shields.io/badge/vgi--lint-100%2F100-brightgreen">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

Query the [Open-Meteo](https://open-meteo.com) weather API family directly from
**DuckDB** as SQL table functions, via the [VGI](https://github.com/Query-farm)
(Vector Gateway Interface) protocol. Forecasts, historical reanalysis, air
quality, marine, flood, climate projections, geocoding, and elevation — plus
inline macros that decode raw weather/wind/AQI/UV codes into human-readable
labels.

## Attach

The catalog name is **`open_meteo`** — the first string in `ATTACH '<name>'`
must be exactly that. Pick a transport:

```sql
-- Hosted Cloudflare Worker (nothing to install)
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'https://vgi-open-meteo.rusty-bb6.workers.dev');

-- Run the worker yourself, straight from npm. DuckDB spawns it as a
-- subprocess and talks VGI over stdin/stdout; -y skips the install prompt.
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'npx -y @query-farm/vgi-open-meteo');

-- Self-hosted HTTP server (see Docker, below)
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'http://localhost:8000');

-- From a clone, without installing anything
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'bun run /path/to/vgi-open-meteo/src/bin/worker.ts');
```

`TYPE vgi` requires a DuckDB build with the VGI extension (e.g.
[haybarn](https://github.com/Query-farm)); `httpfs` is auto-loaded for the HTTP
transports. The hosted worker and source build require a VGI client supporting
protocol **2.1.0** (VGI TypeScript 0.38 / VGI RPC 0.26). Upgrade older VGI
extensions before connecting.

The hosted worker also answers in a browser — open
<https://vgi-open-meteo.rusty-bb6.workers.dev> for the catalog tree, every
function's signature and docs, and a copy-paste `ATTACH` line.

### Run it yourself

The npm package is a single self-contained bundle — no transitive installs, and
it runs on plain **node** (>= 20), which is what `npx` gives you:

```bash
npx -y @query-farm/vgi-open-meteo     # speaks VGI on stdin/stdout
```

Or serve it over HTTP with the container image, which is what you want for a
shared deployment:

```bash
docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-open-meteo:latest
curl -s localhost:8000/health
```

Set `VGI_SIGNING_KEY` to a stable secret in any real deployment — without one
the server mints a random key at boot, and state tokens stop working across a
restart.

## Quick start

```sql
-- Current conditions at a coordinate (Berlin)
SELECT * FROM m.main.forecast_current(52.52, 13.41);

-- Next 3 days, hourly, in local time
SELECT time AT TIME ZONE 'Europe/Berlin' AS local_time, temperature_2m
FROM m.main.forecast_hourly(52.52, 13.41, forecast_days := 3)
ORDER BY time;

-- ...or skip the coordinate lookup entirely and name the place
SELECT g.name, w.temperature_2m, m.main.weather_code_text(w.weather_code) AS conditions
FROM m.main.geocoding('Berlin', count := 1) AS g,
     LATERAL m.main.forecast_current(g.latitude, g.longitude) AS w;
```

Coordinates are what the API takes, but a place name is usually what you have.
`geocoding` bridges the two and the positional arguments accept columns, so the
whole thing stays one query — see [Place names → weather, in one
query](#place-names--weather-in-one-query).

`latitude`/`longitude` are **required positional** arguments; everything else is
a **named** optional argument (`timezone`, `forecast_days`, `past_days`,
`temperature_unit`, `wind_speed_unit`, `precipitation_unit`, `model`). Specialist
functions retain their `models` argument. Historical
and climate functions also require positional `start_date` and `end_date`.
Timestamps always come back in **UTC**; a `timezone`
argument controls the requested time window and daily boundaries. Daily functions
default to the location’s timezone (`auto`) where supported and also return a
calendar `date`; other functions default to GMT.

## Functions

| Function | What it returns |
| --- | --- |
| `forecast_hourly` / `forecast_daily` / `forecast_current` | Weather forecast (up to 16 days) |
| `historical_hourly` / `historical_daily` | Reanalysis weather, 1940→present (needs `start_date`, `end_date`) |
| `air_quality_hourly` / `air_quality_current` | Pollutants + US/European AQI |
| `marine_hourly` / `marine_daily` | Wave and swell |
| `flood_daily` | River discharge / flood outlook |
| `climate_daily` | Downscaled climate projections, 1950→2050 (needs `start_date`, `end_date`, `models`) |
| `geocoding` | Place-name search → coordinates (positional `name`) |
| `elevation` | Terrain elevation for a coordinate |

Every one of them takes its coordinate (or place name) as a **positional**
argument, so there is nothing to `SELECT *` from without `()`. The one
exception is the `weather_codes` view — the WMO 4677 table, no arguments, three
columns (`code`, `description`, `emoji`) — which is browsable on its own and
joins to any `weather_code` column:

```sql
SELECT * FROM m.main.weather_codes ORDER BY code;

SELECT f.time, w.emoji, w.description
FROM m.main.forecast_hourly(52.52, 13.41, forecast_days := 1) f
JOIN m.main.weather_codes w ON w.code = f.weather_code
ORDER BY f.time;
```

## Decoding macros

Several columns come back as raw codes. These **macros** translate them to
labels. They are plain SQL that DuckDB expands inline — no network round-trip —
so use them freely. Call them schema-qualified (`m.main.<macro>`):

| Macro | Example |
| --- | --- |
| `weather_code_text(code)` | `61` → `Slight rain` |
| `weather_code_emoji(code)` | `95` → ⛈️ |
| `wind_compass(degrees)` | `315` → `NW` |
| `us_aqi_category(aqi)` | `120` → `Unhealthy for Sensitive Groups` |
| `european_aqi_category(aqi)` | `75` → `Poor` |
| `uv_index_category(uv)` | `9` → `Very High` |

```sql
SELECT time,
       round(temperature_2m, 1)                AS temp_c,
       m.main.weather_code_emoji(weather_code) AS icon,
       m.main.weather_code_text(weather_code)  AS conditions,
       m.main.wind_compass(wind_direction_10m) AS wind_from
FROM m.main.forecast_hourly(52.52, 13.41, forecast_days := 1)
ORDER BY time;
```

## Place names → weather, in one query

Positional arguments accept **columns**, not just literals, so a place name can
flow straight through to its weather in a single statement — `geocoding` turns
the name into coordinates and the forecast function reads them from its row:

```sql
SELECT g.name,
       g.admin1,
       round(w.temperature_2m, 1)                AS temp_c,
       m.main.weather_code_emoji(w.weather_code) AS icon,
       m.main.weather_code_text(w.weather_code)  AS conditions
FROM m.main.geocoding('Glen Allen', count := 1, country_code := 'US') AS g,
     LATERAL m.main.forecast_current(g.latitude, g.longitude) AS w;
```

The same shape does many places at once — a join, not a `UNION ALL` per site:

```sql
SELECT p.city,
       round(w.temperature_2m, 1)               AS temp_c,
       m.main.weather_code_text(w.weather_code) AS conditions
FROM (VALUES ('Berlin'), ('Tokyo'), ('Glen Allen')) AS p(city),
     LATERAL m.main.geocoding(p.city, count := 1) AS g,
     LATERAL m.main.forecast_current(g.latitude, g.longitude) AS w
ORDER BY p.city;
```

Literals still work exactly as before — `forecast_current(37.66542, -77.49359)`
is the same function, called with a one-row input.

### How many requests a join makes

A `LATERAL` over many places does not make one Open-Meteo request per row.
The weather functions pack the distinct coordinates of each batch into
multi-location requests (up to 100 places, and about 10 of Open-Meteo's
weighted API calls, per request) and stream the answer back a few requests at a
time, so a large join returns its first rows quickly and never holds the whole
result in the worker. `elevation` sends 100 points per request, and `geocoding`
looks up 8 names at a time. Duplicate coordinates are fetched once.

Packing saves round trips, not quota: Open-Meteo still counts every location
(more for over 10 variables or over two weeks of data), so a join over
thousands of places can hit the free tier's per-minute limit. A `LIMIT` on such
a join stops at the end of the current batch of input rows (up to 2,048), not
mid-batch.

For daily data you usually want each place's days to run midnight to midnight
*locally* — Tokyo's "today" is not Berlin's. Pass `timezone := 'auto'`:
Open-Meteo resolves `'auto'` per location from each row's coordinates, so each
city gets its own zone, even though the argument is a single constant:

```sql
SELECT p.city, d.date, d.temperature_2m_max, d.temperature_2m_min
FROM (VALUES ('Berlin'), ('Tokyo'), ('Glen Allen')) AS p(city),
     LATERAL m.main.geocoding(p.city, count := 1) AS g,
     LATERAL m.main.forecast_daily(g.latitude, g.longitude, timezone := 'auto') AS d
ORDER BY p.city, d.date;
```

Named arguments are constants, so `timezone := g.timezone` is rejected by
DuckDB ("does not support lateral join column parameters") — `'auto'` is the
way to get a per-location zone. The returned instants are UTC either way.
Open-Meteo uses one fixed UTC offset within a response, so daily intervals that
cross a daylight-saving transition can differ from civil midnight-to-midnight days.

## Units and options

```sql
-- Imperial units
SELECT * FROM m.main.forecast_current(52.52, 13.41,
  temperature_unit := 'fahrenheit', wind_speed_unit := 'mph');

-- Historical range (yyyy-mm-dd, inclusive)
SELECT * FROM m.main.historical_daily(52.52, 13.41, '2024-06-01', '2024-06-07');
```

`temperature_unit` ∈ {`celsius`,`fahrenheit`}, `wind_speed_unit` ∈
{`kmh`,`ms`,`mph`,`kn`}, `precipitation_unit` ∈ {`mm`,`inch`}.

## Semantic model

The catalog identity is `farm.query.open_meteo`. Every output field from a
modeled function is selectable using its SQL name, such as `temperature_2m`,
`relative_humidity_2m`, `rain` or `wind_direction_10m`. Readable titles explain
those names. Each field has an explicit definition and applicable units;
only useful, deliberately chosen aggregates become measures. Adding an output
column requires a reviewed definition and a field-coverage test.

| Entity | Use it for |
| --- | --- |
| `geocoding` | Resolve and disambiguate a place; feed its coordinates into weather |
| `forecast_current` | All current fields, including precipitation, pressure, cloud cover and gusts |
| `forecast_hourly` / `historical_hourly` | Hourly values including dew point; forecast precipitation probability; temperature extremes and precipitation totals |
| `forecast_daily` / `historical_daily` | Daily fields including sunrise/sunset and solar energy; period totals and extremes |
| `air_quality_current` / `air_quality_hourly` | All returned pollutants, dust, UV and AQI; peak forecast AQI and mean PM2.5 |
| `weather_codes` | Readable `description` and `emoji`, linked from weather entities |
| `elevation` | Terrain height at a coordinate |

Marine, flood, climate, ensemble and previous-run functions remain available
through SQL with their full schemas and examples. They are outside this curated
semantic model. Request options remain parameters; requested latitude/longitude
and response provenance remain selectable context. Forecast and historical
functions accept one `model` selector in SQL and in semantic parameters, with
`best_match` as the default. For historical analysis across decades, an explicit
`model := 'era5'` selects a consistent reanalysis product. Model lists are rejected
because their suffixed output columns do not fit these functions' fixed schemas.

**Daily questions use `date`.** Daily functions return a SQL `DATE` alongside
the UTC `time` instant and default to `timezone := 'auto'` where supported. The
date labels the provider's daily interval in the requested zone, so Tokyo's
January 1 is January 1 even though its interval starts on December 31 in UTC.
Select `date` for one result per provider day, or omit it for a period summary.
It is a calendar dimension, with no implicit UTC time rollup. An explicit
`timezone := 'GMT'` requests UTC days. Hourly semantic time rollups use UTC;
choose the daily entity for provider daily summaries. The provider holds one
UTC offset throughout a response, so these intervals do not follow DST changes
within that response. Hourly precipitation timestamps label the preceding hour;
grouping labels by UTC date does not redistribute amounts by interval overlap.

Measures describe the operation: `total_precipitation` sums amounts,
`highest_temperature` takes a maximum, `lowest_temperature` takes a minimum,
and `total_precipitation_hours` sums the provider's wet-hour counts, rather than
an exact duration of rainfall. `days_with_precipitation` counts days with a
reported amount greater than zero; it is not a threshold-based climate index.
Daily highs and lows are not averaged
into a supposed mean temperature. Current snapshots have values, not period
measures. Peak AQI is a maximum of supplied hourly index values, not a newly
computed regulatory daily index.

For example, pass this request to a semantic query consumer for Tokyo's next
seven provider days as a single period summary:

```json
{
  "measures": [
    {"catalog_id": "farm.query.open_meteo", "entity_id": "forecast_daily", "member_id": "total_precipitation"},
    {"catalog_id": "farm.query.open_meteo", "entity_id": "forecast_daily", "member_id": "highest_temperature"}
  ],
  "parameters": {"latitude": 35.69, "longitude": 139.69, "forecast_days": 7}
}
```

Units follow the request's temperature, wind and precipitation options. In metric
mode, precipitation is water equivalent in **mm**, while snowfall is new snow
depth in **cm**; both use inches in imperial mode. Snow depth must not be added
to total precipitation. Hourly solar irradiance uses **W/m²** and daily solar
energy uses **MJ/m²**. Coverage counts are dimensionless; wet-hour totals use hours.

Aggregates exclude missing values; an entirely missing precipitation period
returns NULL, not zero. Coverage is specific to each variable:
`precipitation_days_with_data`, `temperature_days_with_data` (both high and low),
`precipitation_hours_with_data`, `temperature_hours_with_data` and
`pm2_5_hours_with_data`. Counts describe supplied samples, including any
interpolation, rather than observational independence or accuracy.

**An existing points table can drive weather directly.** Register it as a
semantic entity with a stable site identifier as its grain, plus latitude and
longitude members. Bind those members to the weather function's arguments.
For example, with a modeled `example.locations.points` entity:

```json
{
  "measures": [
    {"catalog_id": "farm.query.open_meteo", "entity_id": "forecast_daily", "member_id": "total_precipitation"}
  ],
  "source_bindings": [{
    "entity": {"catalog_id": "farm.query.open_meteo", "entity_id": "forecast_daily"},
    "driver": {"entity": {"catalog_id": "example.locations", "entity_id": "points"}, "max_rows": 100},
    "arguments": {
      "latitude": {"member": {"catalog_id": "example.locations", "entity_id": "points", "member_id": "latitude"}},
      "longitude": {"member": {"catalog_id": "example.locations", "entity_id": "points", "member_id": "longitude"}}
    }
  }],
  "parameters": {"forecast_days": 7}
}
```

The compiler retains each site's identity, including distinct sites sharing
coordinates. These precipitation totals accumulate time at each site; adding
them across sites does not give regional precipitation. Rows with missing
coordinates produce no weather rows and are omitted by semantic source bindings.
To retain those sites, use SQL `LEFT JOIN LATERAL ... ON true`; see the executable
points-table example in [test/semantic/queries.py](test/semantic/queries.py).

Optional to-one relationships to `weather_codes` provide readable conditions
without dropping rows with an unknown code. Hourly entities explicitly conform
UTC hour and requested coordinates for weather/air-quality comparisons. Daily
dates are not declared equivalent to UTC hours.

**Forecast interpretation.** `forecast_hourly.dew_point_2m` is a temperature at
the valid time and follows the temperature-unit option.
`precipitation_probability` is a percentage for the preceding hour, using the
provider's nominal 0.1 mm/hour precipitation threshold. It stays a percentage
with imperial units. Source calculations and interpolation can use coarser
intervals. `maximum_hourly_precipitation_probability` returns the largest
hourly probability, not the chance of precipitation during the whole period.
Hourly events are not independent, so summing probabilities or multiplying
their complements does not give a valid period probability.

**Provenance travels with the values.** Every modeled weather/air-quality row
includes `model_selection`, `source_endpoint`, `retrieved_at`, `grid_latitude`,
`grid_longitude`, `location_elevation`, `response_timezone` and
`utc_offset_seconds`. For example:

```sql
SELECT time, dew_point_2m, precipitation_probability,
       model_selection, grid_latitude, grid_longitude, retrieved_at
FROM m.main.forecast_hourly(52.52, 13.41, model := 'gfs_global', forecast_days := 1)
ORDER BY time;
```

The model selector records what was requested. Blended or derived fields can
use auxiliary sources; it does not prove the source model of every value.
Returned grid coordinates may differ from requested site coordinates, and
`location_elevation` is the provider's target/downscaling elevation, not
necessarily raw grid elevation. Missing provider metadata stays NULL.
`retrieved_at` records completed upstream retrieval and is preserved on worker
cache hits. It is not forecast issue time or a guarantee of data freshness.

Regular responses do not supply a unique model initialization, issue time or
lead time. The `open_meteo.provenance` function tag makes these omissions
machine-readable. Open-Meteo's [model-update metadata](https://open-meteo.com/en/docs/model-updates#metadata-api-documentation)
cannot reliably identify the run behind those responses. Analyses requiring an
explicit initialization must use a run-specific data source such as the
[Single Runs API](https://open-meteo.com/en/docs/single-runs-api#data-sources).

**Reporting intervals are explicit.** Forecast and historical rows expose
`interval_start`, `interval_end` and `interval_seconds`. These describe nominal
aggregation windows; the metadata below identifies which fields use them.
Hourly accumulation windows end at `time`, provider days start at `time`, and
current accumulation windows use the provider's returned duration. If that
current duration is missing, its bounds stay NULL.

The versioned `open_meteo.temporal` function tag maps each weather variable to
one of five support types. Instantaneous readings do not inherit a row's
accumulation window, and source-dependent fields have no asserted common bounds.

| Support | Meaning |
| --- | --- |
| `instant` | Value at its `time_member`, normally `time` |
| `preceding_interval` | Amount, mean, maximum or probability over the interval ending at `time` |
| `provider_day` | Summary over the provider's fixed-offset daily interval |
| `event_time` | Event timestamp such as `sunrise` or `sunset` |
| `source_dependent` | Temporal support varies by source, interpolation or pollutant |

For example, hourly precipitation has `statistic: "sum"`,
`duration_seconds: 3600`, `start_member: "interval_start"` and
`end_member: "interval_end"`. Current precipitation uses
`duration_member: "interval_seconds"`. The probability threshold is explicitly
nominal; metadata does not assert a universal exact threshold comparison.

```sql
SELECT tags['open_meteo.temporal'], tags['open_meteo.provenance']
FROM duckdb_functions()
WHERE database_name = 'm' AND function_name = 'forecast_hourly';
```

These are worker-specific tags alongside standard VGI semantic members. The
current semantic compiler does not enforce interval-aware aggregation from
these tags; consumers must inspect them. The interval and provenance columns
are ordinary selectable semantic dimensions.

Definitions follow Open-Meteo's [forecast variables](https://open-meteo.com/en/docs#hourly-parameter-definition),
[historical variables and sources](https://open-meteo.com/en/docs/historical-weather-api#hourly-parameter-definition)
and [air-quality variables](https://open-meteo.com/en/docs/air-quality-api#hourly-parameter-definition).
Forecast `rain` excludes separately modeled showers; archive `rain` includes
them. Current weather normally uses 15-minute data that may be interpolated, whereas
current air quality uses hourly data. Historical weather contains modeled
estimates from potentially different products, rather than station observations
or a guaranteed homogeneous climate-trend series.

The metadata is carried in DuckDB's `vgi.semantic_*` tags. See
[src/semantic.ts](src/semantic.ts) for definitions and
[test/semantic/queries.py](test/semantic/queries.py) for executable examples.
Run `make test-semantic` with a local `vgi-lint-check` checkout to test the real
worker and reference compiler against deterministic weather fixtures.

## Commercial API key (optional)

Free tier needs no key. Commercial Open-Meteo customers pass their key at attach
time; every request then routes to the `customer-*` endpoints:

```sql
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION '…', apikey 'YOUR_KEY');
```

## Caching

`geocoding` and `elevation` tell DuckDB their results are cacheable, so repeats
are served **inside DuckDB** — no round-trip to this service, and no call to
Open-Meteo. Both also opt into per-value memoization, which keys on each
distinct input rather than the whole scan, so a `LATERAL` over a table of names
or coordinates only pays for the ones it has not seen:

```sql
-- second run of this serves every city from the memo
SELECT p.city, g.latitude, g.longitude
FROM (VALUES ('Berlin'), ('Tokyo'), ('Glen Allen')) AS p(city),
     LATERAL m.main.geocoding(p.city, count := 1) AS g;

SELECT hits, misses, exchange_hits, exchange_stores FROM vgi_result_cache_stats();
```

They can do this because neither has an upstream schedule: place names and
terrain elevation are static datasets, so the only question is how long to trust
a value (7 days and 30 days respectively, and stale answers are served rather
than failing a query if Open-Meteo rate-limits us).

The **weather** functions deliberately advertise nothing. Their data turns over
when a forecast model publishes a new run, at intervals that drift by hours, and
a cache window measured from when *you* asked would happily serve a superseded
forecast. Getting that right means expiring at the next model issuance, which
this service does not do yet — so it does not pretend to.

## Discovering docs from SQL

Every function, macro, column, and argument is documented in the catalog's
`vgi.*` metadata, and it's all queryable from DuckDB:

```sql
-- Object docs: descriptions, example queries, keywords, category
SELECT function_name, tags
FROM duckdb_functions() WHERE database_name = 'open_meteo';

-- Per-argument docs + machine-readable constraints (choices / range / pattern)
SELECT function_name, arg_name, arg_description, arg_choices, arg_range, arg_pattern
FROM vgi_function_arguments() WHERE catalog_name = 'm';

-- A macro's exact mapping
SELECT macro_definition FROM duckdb_functions() WHERE function_name = 'weather_code_text';
```

`duckdb_functions().tags` holds `vgi.doc_llm` / `vgi.doc_md` / `vgi.example_queries`
/ `vgi.keywords`; `vgi_function_arguments()` holds the argument descriptions and
the `choices` / `ge`/`le` / `pattern` constraints (so an agent can discover valid
inputs). Both cover the table functions and the macros.

## Development

See [CLAUDE.md](CLAUDE.md) for architecture, the build/test workflow (`make
test`), the Cloudflare deploy (`make cf-deploy`), and how the catalog documents
itself for [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check).

## License

MIT — see [LICENSE](LICENSE). Weather data © Open-Meteo, licensed
[CC BY 4.0](https://open-meteo.com/en/license).
