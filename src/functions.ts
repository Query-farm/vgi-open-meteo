// VGI table functions for the Open-Meteo weather API family.
//
// The eleven "block" functions (forecast/historical/air-quality/marine/flood/
// climate × hourly/daily/current) are generated from EndpointConfig records by
// defineWeatherFunction(). Two bespoke functions — geocoding() and elevation()
// — don't follow the block shape and are defined directly.

import { Float64, Int64, Utf8, type DataType } from "@query-farm/apache-arrow";
import {
  batchFromColumns,
  defineTableFunction,
  type ArgumentConstraints,
  type VgiFunction,
} from "vgi";

import { ENDPOINTS, type EndpointConfig } from "./endpoints.js";
import { blockSchema, ELEVATION_SCHEMA, GEOCODING_SCHEMA, resultColumnsMd } from "./schemas.js";

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
// Block-function generator
// ============================================================================

/** Build the args / argDefaults / argDocs / argConstraints maps for an endpoint. */
function buildArgSpec(config: EndpointConfig): {
  args: Record<string, DataType>;
  argDefaults: Record<string, any>;
  argDocs: Record<string, string>;
  argConstraints: Record<string, ArgumentConstraints>;
} {
  // latitude/longitude (and, for archive/climate, start_date/end_date) have no
  // defaults → positional required args. Everything else gets a default →
  // named optional args, e.g. forecast_hourly(52.52, 13.41, timezone := 'auto').
  const args: Record<string, DataType> = {
    latitude: new Float64(),
    longitude: new Float64(),
  };
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
    args.start_date = new Utf8();
    args.end_date = new Utf8();
    argDocs.start_date = "Start date, yyyy-mm-dd (inclusive).";
    argDocs.end_date = "End date, yyyy-mm-dd (inclusive).";
    argConstraints.start_date = { pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
    argConstraints.end_date = { pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  }
  if (config.args.forecastDays) {
    args.forecast_days = new Int64();
    args.past_days = new Int64();
    argDefaults.forecast_days = BigInt(config.defaultForecastDays ?? 7);
    argDefaults.past_days = 0n;
    argDocs.forecast_days = "Number of forecast days to return.";
    argDocs.past_days = "Number of past days to include.";
    argConstraints.forecast_days = { ge: 0 };
    argConstraints.past_days = { ge: 0 };
  }
  if (config.args.timezone) {
    args.timezone = new Utf8();
    argDefaults.timezone = "GMT";
    argDocs.timezone = "IANA timezone or 'auto'. Daily aggregates are bucketed in this zone; time columns are always emitted as UTC.";
  }
  if (config.args.units) {
    args.temperature_unit = new Utf8();
    args.wind_speed_unit = new Utf8();
    args.precipitation_unit = new Utf8();
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
    args.models = new Utf8();
    argDefaults.models = config.defaultModels ?? "";
    argDocs.models = "Comma-separated model ids (empty = Open-Meteo default).";
  }
  return { args, argDefaults, argDocs, argConstraints };
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

  const reqPos = config.args.dateRange ? ", '2024-06-01', '2024-06-07'" : "";
  const extras: string[] = [];
  if (config.args.dateRange) extras.push("a start_date/end_date range is required (yyyy-mm-dd)");
  if (config.args.forecastDays) extras.push("the window is set with forecast_days / past_days");
  if (config.args.units) extras.push("units are configurable (temperature_unit, wind_speed_unit, precipitation_unit)");
  if (config.args.models) extras.push("specific models can be selected with the models argument");
  if (config.args.timezone) extras.push("timezone only shifts how daily buckets are aligned — instants stay UTC");
  const extraNote = extras.length ? ` Notes: ${extras.join("; ")}.` : "";

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
    "```sql",
    `SELECT * FROM ${QUALIFY(config.name)}(52.52, 13.41${reqPos})`,
    "```",
  ].join("\n");

  return {
    "vgi.doc_llm": docLlm,
    "vgi.doc_md": docMd,
    "vgi.result_columns_md": resultColumnsMd(outputSchema),
    "vgi.category": config.category,
  };
}

function defineWeatherFunction(config: EndpointConfig): VgiFunction {
  const outputSchema = blockSchema(config);
  const isCurrent = config.block === "current";
  const variableList = config.variables.map((v) => v.name).join(",");
  const { args, argDefaults, argDocs, argConstraints } = buildArgSpec(config);
  const qname = QUALIFY(config.name);

  // Rough row-count hints for the optimizer.
  const estimate = isCurrent
    ? 1
    : config.block === "hourly"
      ? (config.defaultForecastDays ?? 7) * 24
      : (config.defaultForecastDays ?? 7);

  // Build runnable, varied examples tailored to the endpoint's arguments —
  // these are what `duckdb_functions().examples` surfaces to SQL explorers.
  // References are catalog-qualified so they bind regardless of ATTACH alias.
  const base = config.description.replace(/\.$/, "");
  // start_date/end_date are REQUIRED positional args for the archive/climate
  // endpoints, so every example for those must supply them.
  const reqPos = config.args.dateRange ? ", '2024-06-01', '2024-06-07'" : "";
  const examples: { sql: string; description: string }[] = [
    {
      sql: `SELECT * FROM ${qname}(52.52, 13.41${reqPos})`,
      description: config.args.dateRange
        ? `${base} over an explicit date range (Berlin).`
        : `${base} (Berlin).`,
    },
  ];
  if (config.args.forecastDays) {
    const tz = config.args.timezone ? ", timezone := 'auto'" : "";
    examples.push({
      sql: `SELECT * FROM ${qname}(52.52, 13.41, forecast_days := 3${tz})`,
      description: config.args.timezone
        ? "Next 3 days, daily buckets in the location's local time zone."
        : "Next 3 days.",
    });
    examples.push({
      sql: `SELECT * FROM ${qname}(52.52, 13.41, past_days := 7, forecast_days := 0)`,
      description: "The past 7 days instead of the forecast window.",
    });
  }
  if (config.args.units) {
    examples.push({
      sql: `SELECT * FROM ${qname}(52.52, 13.41${reqPos}, temperature_unit := 'fahrenheit', wind_speed_unit := 'mph')`,
      description: "Imperial units (°F, mph).",
    });
  }
  if (config.args.models && config.defaultModels) {
    examples.push({
      sql: `SELECT * FROM ${qname}(52.52, 13.41, '2040-01-01', '2040-12-31', models := 'MRI_AGCM3_2_S,EC_Earth3P_HR')`,
      description: "Pick specific downscaled climate models.",
    });
  }

  return defineTableFunction<Record<string, any>>({
    name: config.name,
    description: config.description,
    args,
    argDefaults,
    argDocs,
    argConstraints,
    projectionPushdown: true,
    categories: config.categories,
    tags: blockFunctionTags(config, outputSchema),
    onBind: () => ({ outputSchema }),
    cardinality: () => ({ estimate, max: null }),
    process: async (params, _state, out) => {
      const apikey = apiKeyFromParams(params);

      const q: OmQuery = {
        latitude: params.args.latitude,
        longitude: params.args.longitude,
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
        q.start_date = params.args.start_date;
        q.end_date = params.args.end_date;
      }
      if (config.args.models && params.args.models) {
        q.models = params.args.models as string;
      }

      const data = await omGet(config.host, config.path, q, {
        apikey,
        ttlMs: config.cacheTtlMs,
      });
      const offset = Number(data?.utc_offset_seconds ?? 0);
      const cols = parseBlock(data?.[config.block], config.variables, offset, isCurrent);
      out.emit(batchFromColumns(cols, params.outputSchema));
      out.finish();
    },
    examples,
  });
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

const geocoding = defineTableFunction<GeocodingArgs>({
  name: "geocoding",
  description: "Search places by name and return their coordinates (Open-Meteo geocoding).",
  args: {
    name: new Utf8(),
    count: new Int64(),
    language: new Utf8(),
    country_code: new Utf8(),
  },
  argDefaults: { count: 10n, language: "en", country_code: "" },
  argDocs: {
    name: "Place name to search for (>= 2 characters).",
    count: "Maximum number of results (1-100).",
    language: "Result language (e.g. en, de, fr).",
    country_code: "ISO-3166-1 alpha2 filter (empty = any country).",
  },
  argConstraints: {
    count: { ge: 1, le: 100 },
    // empty (= any country) or a 2-letter ISO-3166-1 alpha2 code
    country_code: { pattern: "^([A-Za-z]{2})?$" },
  },
  projectionPushdown: true,
  filterPushdown: true,
  autoApplyFilters: true,
  categories: ["weather", "geocoding", "reference"],
  tags: {
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
      "This is the name → coordinate bridge for the rest of the catalog: read the `latitude`/`longitude` of a match, then call a `forecast_*`, `marine_*`, `air_quality_*` or `elevation` function with those numbers. Arguments must be literals, so do it as two steps rather than a correlated join.",
      "",
      "```sql",
      "SELECT name, latitude, longitude, country FROM open_meteo.main.geocoding('Berlin', count := 5)",
      "```",
    ].join("\n"),
    "vgi.result_columns_md": resultColumnsMd(GEOCODING_SCHEMA),
  },
  onBind: () => ({ outputSchema: GEOCODING_SCHEMA }),
  cardinality: () => ({ estimate: 10, max: 100 }),
  process: async (params, _state, out) => {
    const apikey = apiKeyFromParams(params);
    const data = await omGet(
      "geocoding-api.open-meteo.com",
      "/v1/search",
      {
        name: params.args.name,
        count: Number(params.args.count),
        language: params.args.language || "en",
        countryCode: params.args.country_code || undefined,
        format: "json",
      },
      { apikey, ttlMs: 24 * 60 * 60 * 1000 },
    );

    const results: any[] = Array.isArray(data?.results) ? data.results : [];
    const cols: Record<string, any[]> = {
      id: [], name: [], latitude: [], longitude: [], elevation: [],
      feature_code: [], country_code: [], country: [],
      admin1: [], admin2: [], admin3: [], admin4: [],
      timezone: [], population: [], postcodes: [],
    };
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
    }

    out.emit(batchFromColumns(cols, params.outputSchema));
    out.finish();
  },
  examples: [
    { sql: "SELECT * FROM open_meteo.main.geocoding('Berlin')", description: "Find places named Berlin." },
    {
      sql: "SELECT name, latitude, longitude, country FROM open_meteo.main.geocoding('Springfield', count := 20)",
      description: "Up to 20 matches (coordinates feed the forecast_* functions).",
    },
    {
      sql: "SELECT name, latitude, longitude FROM open_meteo.main.geocoding('München', language := 'de', country_code := 'DE')",
      description: "Localized search restricted to one country.",
    },
  ],
});

// ============================================================================
// elevation — terrain elevation for a coordinate
// ============================================================================

interface ElevationArgs {
  latitude: number;
  longitude: number;
}

const elevation = defineTableFunction<ElevationArgs>({
  name: "elevation",
  description: "Terrain elevation (90m DEM) for a coordinate (Open-Meteo elevation).",
  args: { latitude: new Float64(), longitude: new Float64() },
  argDocs: {
    latitude: "Latitude in degrees north (WGS84).",
    longitude: "Longitude in degrees east (WGS84).",
  },
  argConstraints: {
    latitude: LATITUDE_CONSTRAINT,
    longitude: LONGITUDE_CONSTRAINT,
  },
  projectionPushdown: true,
  categories: ["weather", "reference"],
  tags: {
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
      "Returns exactly one row: the requested `latitude` and `longitude` echoed back, plus `elevation`. `elevation` is null when the model has no value for the point (e.g. open ocean).",
      "",
      "```sql",
      "SELECT elevation FROM open_meteo.main.elevation(52.52, 13.41)",
      "```",
    ].join("\n"),
    "vgi.result_columns_md": resultColumnsMd(ELEVATION_SCHEMA),
  },
  onBind: () => ({ outputSchema: ELEVATION_SCHEMA }),
  cardinality: () => ({ estimate: 1, max: 1 }),
  process: async (params, _state, out) => {
    const apikey = apiKeyFromParams(params);
    const data = await omGet(
      "api.open-meteo.com",
      "/v1/elevation",
      { latitude: params.args.latitude, longitude: params.args.longitude },
      { apikey, ttlMs: 24 * 60 * 60 * 1000 },
    );
    const elev: any[] = Array.isArray(data?.elevation) ? data.elevation : [];
    out.emit(
      batchFromColumns(
        {
          latitude: [params.args.latitude],
          longitude: [params.args.longitude],
          elevation: [elev.length > 0 ? Number(elev[0]) : null],
        },
        params.outputSchema,
      ),
    );
    out.finish();
  },
  examples: [
    { sql: "SELECT elevation FROM open_meteo.main.elevation(52.52, 13.41)", description: "Terrain elevation at Berlin (metres)." },
    { sql: "SELECT * FROM open_meteo.main.elevation(27.99, 86.93)", description: "Near the summit of Everest." },
  ],
});

export const allWeatherFunctions: VgiFunction[] = [
  ...blockFunctions,
  geocoding,
  elevation,
];

export { blockFunctions, geocoding, elevation };
