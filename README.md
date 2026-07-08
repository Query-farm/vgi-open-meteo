# vgi-open-meteo

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
-- Hosted Cloudflare Worker (no setup)
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'https://vgi-open-meteo.rusty-bb6.workers.dev');

-- Local stdio worker (runs the worker as a subprocess)
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'bun run /path/to/vgi-open-meteo/src/bin/worker.ts');

-- Local / self-hosted HTTP server
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION 'http://localhost:8000');
```

`TYPE vgi` requires a DuckDB build with the VGI extension (e.g.
[haybarn](https://github.com/Query-farm)); `httpfs` is auto-loaded for the HTTP
transports.

## Quick start

```sql
-- Current conditions at a coordinate (Berlin)
SELECT * FROM m.main.forecast_current(52.52, 13.41);

-- Next 3 days, hourly, in local time
SELECT time AT TIME ZONE 'Europe/Berlin' AS local_time, temperature_2m
FROM m.main.forecast_hourly(52.52, 13.41, forecast_days := 3)
ORDER BY time;
```

`latitude`/`longitude` are **required positional** arguments; everything else is
a **named** optional argument (`timezone`, `forecast_days`, `past_days`,
`temperature_unit`, `wind_speed_unit`, `precipitation_unit`, `start_date`,
`end_date`, `models`). Timestamps always come back in **UTC**; a `timezone`
argument only controls how *daily* aggregates are bucketed.

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

## Place names → weather (two steps)

VGI table-function arguments must be **literals** — DuckDB rejects
correlated/`LATERAL` column references. So going from a place name to its weather
is a two-step: read the coordinates from `geocoding(...)`, then call a forecast
function with those numbers.

```sql
-- 1. find coordinates
SELECT name, admin1, latitude, longitude
FROM m.main.geocoding('Glen Allen', count := 5, country_code := 'US');
--   → Glen Allen, Virginia ≈ 37.66542, -77.49359

-- 2. current weather there
SELECT temperature_2m, m.main.weather_code_text(weather_code) AS conditions
FROM m.main.forecast_current(37.66542, -77.49359);
```

For several locations, cross-join a coordinates table with `UNION ALL` rather
than a correlated join.

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

## Commercial API key (optional)

Free tier needs no key. Commercial Open-Meteo customers pass their key at attach
time; every request then routes to the `customer-*` endpoints:

```sql
ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION '…', apikey 'YOUR_KEY');
```

## Discovering docs from SQL

Every function, macro, column, and argument is documented in the catalog's
`vgi.*` metadata (LLM/Markdown descriptions, keywords, example queries, result
columns). VGI-aware tooling surfaces these; from plain DuckDB you can also read a
macro's exact mapping with `SELECT macro_definition FROM duckdb_functions()
WHERE function_name = 'weather_code_text'`.

## Development

See [CLAUDE.md](CLAUDE.md) for architecture, the build/test workflow (`make
test`), the Cloudflare deploy (`make cf-deploy`), and how the catalog documents
itself for [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check).

## License

MIT — see [LICENSE](LICENSE). Weather data © Open-Meteo, licensed
[CC BY 4.0](https://open-meteo.com/en/license).
