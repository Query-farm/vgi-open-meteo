// VGI table functions for the Open-Meteo weather API family.
//
// The eleven "block" functions (forecast/historical/air-quality/marine/flood/
// climate × hourly/daily/current) are generated from EndpointConfig records by
// defineWeatherFunction(). Two bespoke functions — geocoding() and elevation()
// — don't follow the block shape and are defined directly.
//
// All of them are **blended row-transform** functions
// (`defineRowTransformFunction`), not plain table functions. That is what makes
// the positional args per-row INPUT COLUMNS rather than bind-time scalars, so a
// single registration serves all three call shapes:
//
//   forecast_hourly(52.52, 13.41)                       -- literal -> 1 input row
//   FROM cities, forecast_hourly(cities.lat, cities.lon) -- streaming
//   FROM cities, LATERAL forecast_hourly(cities.lat, cities.lon)
//
// The last one is the whole point: geocode -> forecast is now one query instead
// of a two-step copy of coordinates. Named args (timezone, forecast_days, units,
// …) stay bind-time scalars on `params.args`; only positional args come off the
// input `batch`.
//
// Two constraints the blended shape imposes, both load-bearing here:
//   1. Map-shaped, NO finalize — DuckDB forbids FinalExecute under correlated
//      LATERAL. Everything must be emitted from process().
//   2. process() emits ONE batch per input batch, and because these are 1->N
//      (an hourly forecast is many rows per coordinate) every emit MUST carry
//      parentRowsMetadata saying which input row produced each output row.
//      Without it the extension assumes an identity 1->1 map and the outer
//      columns get stamped from the wrong row.

// Value imports come from `vgi/worker-cf` (the workerd-safe facade) so the
// Cloudflare bundle doesn't pull in the Node-only stdio Worker via the package
// root. `ArgumentConstraints` is type-only (erased at build) so it's fine from
// the root.
import {
  batchFromColumns,
  cacheControlMetadata,
  constraintSpecFields,
  defineRowTransformFunction,
  float64,
  int64,
  parentRowsMetadata,
  utf8,
  type VgiBatch,
  type VgiDataType,
  type VgiFunction,
} from "vgi/worker-cf";
import type { ArgumentConstraints } from "vgi";

import { ENDPOINTS, type EndpointConfig } from "./endpoints.js";
import { blockSchema, ELEVATION_SCHEMA, GEOCODING_SCHEMA, resultColumnsSchema } from "./schemas.js";

// Catalog-qualified name for example SQL. VGI example rules (and DuckDB itself,
// once the catalog is ATTACHed under a non-default alias) require references to
// be catalog.schema.function, so every generated example is qualified. Must
// match CATALOG_NAME / defaultSchema in catalog.ts.
const QUALIFY = (name: string): string => `open_meteo.main.${name}`;

// WGS84 coordinate bounds, declared as machine-readable constraints so agents
// discover valid inputs via vgi_function_arguments() (and bad literals fail bind).
const LATITUDE_CONSTRAINT: ArgumentConstraints = { ge: -90, le: 90 };
const LONGITUDE_CONSTRAINT: ArgumentConstraints = { ge: -180, le: 180 };
import { parseBlock } from "./weather.js";
import { omGet, type OmQuery } from "./open-meteo.js";
import { apiKeyFromParams } from "./attach-options.js";

// ============================================================================
// Blended-function helpers
// ============================================================================

/**
 * How many upstream Open-Meteo calls a single input batch may have in flight.
 *
 * A blended function is handed a whole input chunk at once, and each row is its
 * own point query — a LATERAL over a 2048-row table is 2048 calls. Unbounded
 * `Promise.all` would open all of them at once and get us rate-limited (and on
 * workerd, exceed the per-request subrequest ceiling). The `omGet` cache
 * collapses duplicate coordinates within a batch for free, so this bounds only
 * the genuinely distinct work.
 */
const MAX_UPSTREAM_CONCURRENCY = 8;

/** Map with bounded concurrency, preserving input order in the result. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Re-attach `ge`/`le`/`choices`/`pattern` to a blended function's arguments.
 *
 * `RowTransformConfig` has no `argConstraints` field (unlike `TableFunctionConfig`),
 * but the constraints live on the ArgumentSpec, which is reachable on the built
 * function — so encode them the same way the table-function path does. Without
 * this the port would silently drop every bound and choice list from
 * `vgi_function_arguments()`, which is where agents discover valid inputs.
 */
function withArgConstraints(
  fn: VgiFunction,
  constraints: Record<string, ArgumentConstraints>,
): VgiFunction {
  for (const spec of fn.argumentSpecs ?? []) {
    const c = constraints[spec.name];
    if (c) Object.assign(spec, constraintSpecFields(c));
  }
  return fn;
}

/**
 * Encode `examples` as the `vgi.example_queries` tag.
 *
 * The SDK's `examples` reach DuckDB through `duckdb_functions().examples`,
 * which carries the SQL and drops the description on the way. Discovery tools
 * read descriptions from this tag instead (vgi-lint VGI515), and merge the two
 * carriers by normalised SQL — so emitting both surfaces each query once, with
 * its description intact.
 */
function exampleQueriesTag(examples: { sql: string; description: string }[]): string {
  return JSON.stringify(examples.map((e) => ({ description: e.description, sql: e.sql })));
}

/** Read a column's value at `row`, normalised to `null` when absent. */
function cell(batch: VgiBatch, name: string, row: number): unknown {
  const v = batch.getChild(name)?.get(row);
  return v === undefined ? null : v;
}

/** Append every value of `src` onto `dst` (avoids the spread arg-count limit). */
function appendAll(dst: any[], src: any[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
}

// ============================================================================
// Block-function generator
// ============================================================================

/** Build the args / namedArgs / argDefaults / argDocs / argConstraints maps for an endpoint. */
function buildArgSpec(config: EndpointConfig): {
  args: Record<string, VgiDataType>;
  namedArgs: Record<string, VgiDataType>;
  argDefaults: Record<string, any>;
  argDocs: Record<string, string>;
  argConstraints: Record<string, ArgumentConstraints>;
} {
  // `args` are POSITIONAL, and on a blended function that means they are the
  // per-row input columns — latitude/longitude, plus start_date/end_date for
  // the archive/climate endpoints that require a range. They are read off the
  // batch in process(), never from params.args.
  //
  // `namedArgs` are the bind-time scalars that keep their defaults and apply to
  // every row of the batch alike, e.g.
  // forecast_hourly(52.52, 13.41, timezone := 'auto').
  const args: Record<string, VgiDataType> = {
    latitude: float64(),
    longitude: float64(),
  };
  const namedArgs: Record<string, VgiDataType> = {};
  // NB: keep the word "decimal" out of arg docs — VGI313 reads it as the DECIMAL
  // data type. The type is exposed separately; docs describe meaning only.
  const argDocs: Record<string, string> = {
    latitude: "Latitude in degrees north (WGS84).",
    longitude: "Longitude in degrees east (WGS84).",
  };
  const argDefaults: Record<string, any> = {};
  const argConstraints: Record<string, ArgumentConstraints> = {
    latitude: LATITUDE_CONSTRAINT,
    longitude: LONGITUDE_CONSTRAINT,
  };

  if (config.args.dateRange) {
    args.start_date = utf8();
    args.end_date = utf8();
    argDocs.start_date = "Start date, yyyy-mm-dd (inclusive).";
    argDocs.end_date = "End date, yyyy-mm-dd (inclusive).";
    argConstraints.start_date = { pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    argConstraints.end_date = { pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  }
  if (config.args.forecastDays) {
    namedArgs.forecast_days = int64();
    namedArgs.past_days = int64();
    argDefaults.forecast_days = BigInt(config.defaultForecastDays ?? 7);
    argDefaults.past_days = 0n;
    argDocs.forecast_days = "Number of forecast days to return.";
    argDocs.past_days = "Number of past days to include.";
    argConstraints.forecast_days = { ge: 0 };
    argConstraints.past_days = { ge: 0 };
  }
  if (config.args.timezone) {
    namedArgs.timezone = utf8();
    argDefaults.timezone = "GMT";
    argDocs.timezone = "IANA timezone or 'auto'. Daily aggregates are bucketed in this zone; time columns are always emitted as UTC.";
  }
  if (config.args.units) {
    namedArgs.temperature_unit = utf8();
    namedArgs.wind_speed_unit = utf8();
    namedArgs.precipitation_unit = utf8();
    argDefaults.temperature_unit = "celsius";
    argDefaults.wind_speed_unit = "kmh";
    argDefaults.precipitation_unit = "mm";
    argDocs.temperature_unit = "Temperature unit for the response.";
    argDocs.wind_speed_unit = "Wind-speed unit for the response.";
    argDocs.precipitation_unit = "Precipitation unit for the response.";
    argConstraints.temperature_unit = { choices: ["celsius", "fahrenheit"] };
    argConstraints.wind_speed_unit = { choices: ["kmh", "ms", "mph", "kn"] };
    argConstraints.precipitation_unit = { choices: ["mm", "inch"] };
  }
  if (config.args.models) {
    namedArgs.models = utf8();
    argDefaults.models = config.defaultModels ?? "";
    argDocs.models = "Comma-separated model ids (empty = Open-Meteo default).";
  }
  return { args, namedArgs, argDefaults, argDocs, argConstraints };
}

/** The vgi.* documentation tags for a generated block function. */
function blockFunctionTags(
  config: EndpointConfig,
  outputSchema: ReturnType<typeof blockSchema>,
): Record<string, string> {
  const rowPhrase =
    config.block === "current"
      ? "returns a single row with the most recent values"
      : config.block === "daily"
        ? "returns one row per day"
        : "returns one row per hour";

  const extras: string[] = [];
  if (config.args.dateRange) extras.push("a start_date/end_date range is required (yyyy-mm-dd)");
  if (config.args.forecastDays) extras.push("the window is set with forecast_days / past_days");
  if (config.args.units) extras.push("units are configurable (temperature_unit, wind_speed_unit, precipitation_unit)");
  if (config.args.models) extras.push("specific models can be selected with the models argument");
  if (config.args.timezone) extras.push("timezone only shifts how daily buckets are aligned — instants stay UTC");
  const extraNote = extras.length ? ` Notes: ${extras.join("; ")}.` : "";

  const cols = config.variables.slice(0, 3).map((v) => `\`${v.name}\``).join(", ");
  const hasWeatherCode = config.variables.some((v) => v.name === "weather_code");
  const decodeNote = hasWeatherCode
    ? " Decode the `weather_code` column with the `weather_code_text` / `weather_code_emoji` macros."
    : "";

  const docLlm =
    `Point weather query returning ${config.block} values from the Open-Meteo API. ` +
    `${config.description} Supply latitude and longitude in WGS84 degrees; it ${rowPhrase}, ` +
    `with the \`time\` column always emitted in UTC.${extraNote}`;

  const docMd = [
    `## ${config.name}`,
    "",
    config.description,
    "",
    `Pass \`latitude\` and \`longitude\` in WGS84 degrees. The function ${rowPhrase}; ` +
      `every timestamp is emitted in UTC.${extraNote}`,
    "",
    `Returned columns are \`time\` plus ${cols} and more — see the result schema for the ` +
      `full set with types.${decodeNote} Runnable queries live in this function's example ` +
      `queries rather than inline here.`,
  ].join("\n");

  return {
    "vgi.doc_llm": docLlm,
    "vgi.doc_md": docMd,
    "vgi.result_columns_schema": resultColumnsSchema(outputSchema),
    "vgi.category": config.category,
  };
}

// TODO(result-cache): the weather functions deliberately advertise no
// `vgi.cache.*` yet. A relative `ttl` is the wrong instrument for them: it is
// anchored to receipt, while the data turns over at model-issuance boundaries,
// so a window fetched just before a run lands serves a superseded forecast for
// its whole duration. Doing this properly means an absolute `expires` derived
// from each host's `/data/<model>/static/meta.json`
// (`last_run_availability_time + update_interval_seconds`, plus ~10min for
// Open-Meteo's eventual consistency), clamped for runs that are already overdue
// and for decommissioned models whose metadata has gone stale. `geocoding` has
// no such schedule, which is why it can opt in today — see GEOCODING_CACHE.
function defineWeatherFunction(config: EndpointConfig): VgiFunction {
  const outputSchema = blockSchema(config);
  const isCurrent = config.block === "current";
  const variableList = config.variables.map((v) => v.name).join(",");
  const { args, namedArgs, argDefaults, argDocs, argConstraints } = buildArgSpec(config);
  const qname = QUALIFY(config.name);

  // Build runnable, varied examples tailored to the endpoint's arguments —
  // these are what `duckdb_functions().examples` surfaces to SQL explorers.
  // References are catalog-qualified so they bind regardless of ATTACH alias.
  const base = config.description.replace(/\.$/, "");
  // start_date/end_date are REQUIRED positional args for the archive/climate
  // endpoints, so every example for those must supply them.
  const reqPos = config.args.dateRange ? ", '2024-06-01', '2024-06-07'" : "";
  // Project a few representative columns instead of `SELECT *`, so each example
  // teaches which columns matter (and isn't a low-effort star dump). `current`
  // is a single row; the rest get an explicit ORDER BY time.
  const preview = ["time", ...config.variables.slice(0, 2).map((v) => v.name)].join(", ");
  const order = isCurrent ? "" : " ORDER BY time";
  const examples: { sql: string; description: string }[] = [
    {
      sql: `SELECT ${preview} FROM ${qname}(52.52, 13.41${reqPos})${order}`,
      description: config.args.dateRange
        ? `${base} over an explicit date range (Berlin).`
        : `${base} (Berlin).`,
    },
  ];
  if (config.args.forecastDays) {
    const tz = config.args.timezone ? ", timezone := 'auto'" : "";
    examples.push({
      sql: `SELECT ${preview} FROM ${qname}(52.52, 13.41, forecast_days := 3${tz})${order}`,
      description: config.args.timezone
        ? "Next 3 days, daily buckets in the location's local time zone."
        : "Next 3 days.",
    });
    examples.push({
      sql: `SELECT ${preview} FROM ${qname}(52.52, 13.41, past_days := 7, forecast_days := 0)${order}`,
      description: "The past 7 days instead of the forecast window.",
    });
  }
  if (config.args.units) {
    examples.push({
      sql: `SELECT ${preview} FROM ${qname}(52.52, 13.41${reqPos}, temperature_unit := 'fahrenheit', wind_speed_unit := 'mph')${order}`,
      description: "Imperial units (°F, mph).",
    });
  }
  if (config.args.models && config.defaultModels) {
    examples.push({
      sql: `SELECT ${preview} FROM ${qname}(52.52, 13.41, '2040-01-01', '2040-12-31', models := 'MRI_AGCM3_2_S,EC_Earth3P_HR')${order}`,
      description: "Pick specific downscaled climate models.",
    });
  }
  // The blended payoff: coordinates can come from a column, so many locations
  // are one correlated join instead of a UNION ALL per site.
  const latPreview = ["w.time", ...config.variables.slice(0, 1).map((v) => `w.${v.name}`)].join(", ");
  examples.push({
    sql:
      `SELECT c.city, ${latPreview} FROM (VALUES ('Berlin', 52.52, 13.41), ('Tokyo', 35.69, 139.69)) AS c(city, lat, lon), ` +
      `LATERAL ${qname}(c.lat, c.lon${reqPos}) AS w`,
    description: "Many locations in one query — coordinates supplied by a column.",
  });

  const fn = defineRowTransformFunction<Record<string, any>>({
    name: config.name,
    description: config.description,
    args,
    namedArgs,
    argDefaults,
    argDocs,
    projectionPushdown: true,
    categories: config.categories,
    tags: {
      ...blockFunctionTags(config, outputSchema),
      "vgi.example_queries": exampleQueriesTag(examples),
    },
    onBind: () => ({ outputSchema }),
    process: async (params, batch, out) => {
      const apikey = apiKeyFromParams(params);

      // One upstream query per input row. Rows whose coordinates (or required
      // dates) are NULL are dropped rather than sent — a 1->0 fan-out, which
      // the provenance array expresses naturally by simply never naming them.
      const pending: { row: number; q: OmQuery }[] = [];
      for (let row = 0; row < batch.numRows; row++) {
        const lat = cell(batch, "latitude", row);
        const lon = cell(batch, "longitude", row);
        if (lat === null || lon === null) continue;

        const q: OmQuery = {
          latitude: Number(lat),
          longitude: Number(lon),
          timeformat: "unixtime",
          [config.block]: variableList,
        };
        if (config.args.timezone) q.timezone = (params.args.timezone as string) || "GMT";
        if (config.args.units) {
          q.temperature_unit = params.args.temperature_unit;
          q.wind_speed_unit = params.args.wind_speed_unit;
          q.precipitation_unit = params.args.precipitation_unit;
        }
        if (config.args.forecastDays) {
          q.forecast_days = Number(params.args.forecast_days);
          q.past_days = Number(params.args.past_days);
        }
        if (config.args.dateRange) {
          const start = cell(batch, "start_date", row);
          const end = cell(batch, "end_date", row);
          if (start === null || end === null) continue;
          q.start_date = String(start);
          q.end_date = String(end);
        }
        if (config.args.models && params.args.models) {
          q.models = params.args.models as string;
        }
        pending.push({ row, q });
      }

      const responses = await mapLimit(pending, MAX_UPSTREAM_CONCURRENCY, (p) =>
        omGet(config.host, config.path, p.q, { apikey, ttlMs: config.cacheTtlMs }),
      );

      // Concatenate every row's block into ONE output batch, recording the
      // input row each output row came from. Emitting per input row instead
      // would be wrong: a blended process() emits a single batch.
      const cols: Record<string, any[]> = { time: [] };
      for (const v of config.variables) cols[v.name] = [];
      const parentRows: number[] = [];

      for (let i = 0; i < pending.length; i++) {
        const data = responses[i];
        const offset = Number(data?.utc_offset_seconds ?? 0);
        const block = parseBlock(data?.[config.block], config.variables, offset, isCurrent);
        appendAll(cols.time, block.time);
        for (const v of config.variables) appendAll(cols[v.name], block[v.name]);
        for (let k = 0; k < block.time.length; k++) parentRows.push(pending[i].row);
      }

      out.emit(
        batchFromColumns(cols, params.outputSchema),
        parentRowsMetadata(parentRows, parentRows.length),
      );
    },
    examples,
  });
  return withArgConstraints(fn, argConstraints);
}

const blockFunctions: VgiFunction[] = ENDPOINTS.map(defineWeatherFunction);

// ============================================================================
// geocoding — place name → coordinates (the bridge to the forecast functions)
// ============================================================================

interface GeocodingArgs {
  name: string;
  count: bigint;
  language: string;
  country_code: string;
}

const GEOCODING_EXAMPLES = [
    {
      sql: "SELECT name, latitude, longitude, country FROM open_meteo.main.geocoding('Berlin')",
      description: "Find places named Berlin.",
    },
    {
      sql: "SELECT name, latitude, longitude, country FROM open_meteo.main.geocoding('Springfield', count := 20)",
      description: "Up to 20 matches (coordinates feed the forecast_* functions).",
    },
    {
      sql: "SELECT name, latitude, longitude FROM open_meteo.main.geocoding('München', language := 'de', country_code := 'DE')",
      description: "Localized search restricted to one country.",
    },
    {
      sql:
        "SELECT p.city, g.name, g.latitude, g.longitude FROM (VALUES ('Berlin'), ('Tokyo')) AS p(city), " +
        "LATERAL open_meteo.main.geocoding(p.city, count := 1) AS g",
      description: "Resolve a whole column of place names in one correlated join.",
    },
];

/**
 * Result-cache advertisement for `geocoding` (`vgi.cache.*`).
 *
 * Unlike every weather endpoint, geocoding has no model-run schedule to align
 * to — GeoNames is a static place database, which is exactly why its host
 * serves no `/data/<model>/static/meta.json` the way the forecast hosts do. So
 * a plain relative `ttl` is the right instrument here: there is no issuance
 * boundary that a fetch-anchored window could drift past and serve a superseded
 * run. (For the forecast functions it is the wrong instrument, which is why
 * they still advertise nothing — see the TODO on defineWeatherFunction.)
 *
 * `perValue` memoizes each distinct input name, which is the whole point for
 * the geocode->forecast bridge: a LATERAL over a city table calls this once per
 * row, against an API whose free tier allows 600 calls/minute. The framework
 * only populates that tier when the function opts in, because a per-value serve
 * costs a probe + decode + assembly and only pays back when calling the worker
 * is more expensive — a rate-limited network round-trip clears that bar easily.
 *
 * The memo key is not just the name: the extension folds the bind arguments
 * (`count` / `language` / `country_code`) and the attach options into the
 * static key, so a `count := 1` memo can never serve a `count := 5` call, nor a
 * free-tier memo serve an apikey'd one.
 *
 * `staleIfError` is deliberately generous — a month-old coordinate for Berlin
 * is a far better answer than a failed query when we get rate-limited.
 */
const GEOCODING_CACHE = {
  ttl: 7 * 24 * 60 * 60,
  perValue: true,
  staleIfError: 30 * 24 * 60 * 60,
};

const geocodingBase = defineRowTransformFunction<GeocodingArgs>({
  name: "geocoding",
  description: "Search places by name and return their coordinates (Open-Meteo geocoding).",
  // `name` is the per-row input column, so LATERAL geocoding(t.city) resolves a
  // whole table of place names in one query.
  args: { name: utf8() },
  namedArgs: {
    count: int64(),
    language: utf8(),
    country_code: utf8(),
  },
  argDefaults: { count: 10n, language: "en", country_code: "" },
  argDocs: {
    name: "Place name to search for (>= 2 characters).",
    count: "Maximum number of results (1-100).",
    language: "Result language (e.g. en, de, fr).",
    country_code: "ISO-3166-1 alpha2 filter (empty = any country).",
  },
  projectionPushdown: true,
  filterPushdown: true,
  autoApplyFilters: true,
  categories: ["weather", "geocoding", "reference"],
  tags: {
    "vgi.example_queries": exampleQueriesTag(GEOCODING_EXAMPLES),
    "vgi.category": "geocoding",
    "vgi.doc_llm":
      "Forward geocoding: search Open-Meteo's place-name database and get coordinates back. " +
      "Use it to turn a name like 'Berlin' into the latitude/longitude the forecast_* and marine/air-quality " +
      "functions need — the bridge from human place names to the coordinate-based weather functions. " +
      "Returns up to `count` candidate places (with country, admin regions, timezone, elevation and population) " +
      "ordered by relevance.",
    "vgi.doc_md": [
      "## geocoding",
      "",
      "Search places by name and return their coordinates and metadata (country, administrative regions, timezone, elevation, population).",
      "",
      "This is the name → coordinate bridge for the rest of the catalog: read the `latitude`/`longitude` of a match, then feed them to a `forecast_*`, `marine_*`, `air_quality_*` or `elevation` function. Both sides take column references, so the bridge is one correlated join rather than two steps — the last example query joins a column of place names straight through to current weather.",
      "",
      "Key columns are `name`, `latitude`, `longitude`, `country` and the `admin1`–`admin4` regions; see the result schema for the full set. Runnable queries are in this function's example queries.",
    ].join("\n"),
    "vgi.result_columns_schema": resultColumnsSchema(GEOCODING_SCHEMA),
  },
  onBind: () => ({ outputSchema: GEOCODING_SCHEMA }),
  process: async (params, batch, out) => {
    const apikey = apiKeyFromParams(params);

    // One search per input name. A blank/NULL name is dropped rather than sent
    // (the API requires >= 2 characters), which is a 1->0 for that row.
    const pending: { row: number; name: string }[] = [];
    for (let row = 0; row < batch.numRows; row++) {
      const name = cell(batch, "name", row);
      if (name === null) continue;
      const text = String(name);
      if (text.length === 0) continue;
      pending.push({ row, name: text });
    }

    const responses = await mapLimit(pending, MAX_UPSTREAM_CONCURRENCY, (p) =>
      omGet(
        "geocoding-api.open-meteo.com",
        "/v1/search",
        {
          name: p.name,
          count: Number(params.args.count),
          language: params.args.language || "en",
          countryCode: params.args.country_code || undefined,
          format: "json",
        },
        { apikey, ttlMs: 24 * 60 * 60 * 1000 },
      ),
    );

    const cols: Record<string, any[]> = {
      id: [], name: [], latitude: [], longitude: [], elevation: [],
      feature_code: [], country_code: [], country: [],
      admin1: [], admin2: [], admin3: [], admin4: [],
      timezone: [], population: [], postcodes: [],
    };
    const parentRows: number[] = [];

    for (let i = 0; i < pending.length; i++) {
      const results: any[] = Array.isArray(responses[i]?.results) ? responses[i].results : [];
      for (const r of results) {
        cols.id.push(r.id != null ? BigInt(r.id) : null);
        cols.name.push(String(r.name ?? ""));
        cols.latitude.push(Number(r.latitude ?? 0));
        cols.longitude.push(Number(r.longitude ?? 0));
        cols.elevation.push(r.elevation != null ? Number(r.elevation) : null);
        cols.feature_code.push(String(r.feature_code ?? ""));
        cols.country_code.push(String(r.country_code ?? ""));
        cols.country.push(String(r.country ?? ""));
        cols.admin1.push(String(r.admin1 ?? ""));
        cols.admin2.push(String(r.admin2 ?? ""));
        cols.admin3.push(String(r.admin3 ?? ""));
        cols.admin4.push(String(r.admin4 ?? ""));
        cols.timezone.push(String(r.timezone ?? ""));
        cols.population.push(r.population != null ? BigInt(r.population) : null);
        cols.postcodes.push(Array.isArray(r.postcodes) ? r.postcodes.map(String) : null);
        parentRows.push(pending[i].row);
      }
    }

    // Cache keys are merged over the provenance map rather than replacing it —
    // the extension latches the advertisement from an exchange's FIRST output,
    // so emitting it on every batch is both harmless and the robust choice.
    out.emit(
      batchFromColumns(cols, params.outputSchema),
      cacheControlMetadata(GEOCODING_CACHE, parentRowsMetadata(parentRows, parentRows.length)),
    );
  },
  examples: GEOCODING_EXAMPLES,
});

const geocoding = withArgConstraints(geocodingBase, {
  count: { ge: 1, le: 100 },
  // empty (= any country) or a 2-letter ISO-3166-1 alpha2 code
  country_code: { pattern: "^([A-Za-z]{2})?$" },
});

// ============================================================================
// elevation — terrain elevation for a coordinate
// ============================================================================

interface ElevationArgs {
  latitude: number;
  longitude: number;
}

/** Coordinates per /v1/elevation call. The endpoint takes comma-separated
 *  lists and answers with one elevation per point; 100 is its documented cap.
 *  This is why elevation batches where the weather blocks cannot — one call
 *  serves 100 input rows instead of 100 calls. */
const ELEVATION_BATCH = 100;

const ELEVATION_EXAMPLES = [
    { sql: "SELECT elevation FROM open_meteo.main.elevation(52.52, 13.41)", description: "Terrain elevation at Berlin (metres)." },
    { sql: "SELECT latitude, longitude, elevation FROM open_meteo.main.elevation(27.99, 86.93)", description: "Near the summit of Everest." },
    {
      sql:
        "SELECT c.name, e.elevation FROM (VALUES ('Berlin', 52.52, 13.41), ('Everest', 27.99, 86.93)) AS c(name, lat, lon), " +
        "LATERAL open_meteo.main.elevation(c.lat, c.lon) AS e",
      description: "Elevation for a whole table of coordinates in one correlated join.",
    },
];

const elevationBase = defineRowTransformFunction<ElevationArgs>({
  name: "elevation",
  description: "Terrain elevation (90m DEM) for a coordinate (Open-Meteo elevation).",
  args: { latitude: float64(), longitude: float64() },
  argDocs: {
    latitude: "Latitude in degrees north (WGS84).",
    longitude: "Longitude in degrees east (WGS84).",
  },
  projectionPushdown: true,
  categories: ["weather", "reference"],
  tags: {
    "vgi.example_queries": exampleQueriesTag(ELEVATION_EXAMPLES),
    "vgi.category": "reference",
    "vgi.doc_llm":
      "Terrain elevation for a coordinate, from Open-Meteo's 90 m digital elevation model. " +
      "Supply latitude/longitude in WGS84 degrees; it returns a single row echoing the requested " +
      "coordinate plus its `elevation` in metres above sea level. Use it for altitude lookups or to " +
      "enrich a coordinate before charting weather against terrain height.",
    "vgi.doc_md": [
      "## elevation",
      "",
      "Terrain elevation (metres above sea level) for a coordinate, sampled from a 90 m digital elevation model (Copernicus DEM).",
      "",
      "Returns exactly one row per coordinate: the requested `latitude` and `longitude` echoed back, plus `elevation`. `elevation` is null where the model has no value for the point (open ocean, for instance). Coordinates may come from a column, and the endpoint takes them in batches of 100, so resolving a whole table of points costs one request per 100 rows rather than one per row.",
    ].join("\n"),
    "vgi.result_columns_schema": resultColumnsSchema(ELEVATION_SCHEMA),
  },
  onBind: () => ({ outputSchema: ELEVATION_SCHEMA }),
  process: async (params, batch, out) => {
    const apikey = apiKeyFromParams(params);

    const pending: { row: number; lat: number; lon: number }[] = [];
    for (let row = 0; row < batch.numRows; row++) {
      const lat = cell(batch, "latitude", row);
      const lon = cell(batch, "longitude", row);
      if (lat === null || lon === null) continue;
      pending.push({ row, lat: Number(lat), lon: Number(lon) });
    }

    // Chunk the batch into multi-coordinate calls rather than one call per row.
    const chunks: (typeof pending)[] = [];
    for (let i = 0; i < pending.length; i += ELEVATION_BATCH) {
      chunks.push(pending.slice(i, i + ELEVATION_BATCH));
    }

    const responses = await mapLimit(chunks, MAX_UPSTREAM_CONCURRENCY, (chunk) =>
      omGet(
        "api.open-meteo.com",
        "/v1/elevation",
        {
          latitude: chunk.map((p) => p.lat).join(","),
          longitude: chunk.map((p) => p.lon).join(","),
        },
        { apikey, ttlMs: 24 * 60 * 60 * 1000 },
      ),
    );

    const cols: Record<string, any[]> = { latitude: [], longitude: [], elevation: [] };
    const parentRows: number[] = [];

    for (let c = 0; c < chunks.length; c++) {
      // Positional: the response's Nth elevation belongs to the Nth coordinate
      // we sent. A short array (upstream returned fewer) yields null, never a
      // silent shift onto the wrong row.
      const elev: any[] = Array.isArray(responses[c]?.elevation) ? responses[c].elevation : [];
      for (let j = 0; j < chunks[c].length; j++) {
        const p = chunks[c][j];
        cols.latitude.push(p.lat);
        cols.longitude.push(p.lon);
        cols.elevation.push(j < elev.length && elev[j] != null ? Number(elev[j]) : null);
        parentRows.push(p.row);
      }
    }

    out.emit(
      batchFromColumns(cols, params.outputSchema),
      parentRowsMetadata(parentRows, parentRows.length),
    );
  },
  examples: ELEVATION_EXAMPLES,
});

const elevation = withArgConstraints(elevationBase, {
  latitude: LATITUDE_CONSTRAINT,
  longitude: LONGITUDE_CONSTRAINT,
});

export const allWeatherFunctions: VgiFunction[] = [
  ...blockFunctions,
  geocoding,
  elevation,
];

export { blockFunctions, geocoding, elevation };
