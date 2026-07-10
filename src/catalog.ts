// VGI catalog for the Open-Meteo worker.
//
// Exposes the weather functions under the `open_meteo` catalog. Every function
// requires latitude/longitude (or a search name) as arguments, so they are
// exposed as table *functions* — there are no zero-arg catalog tables to
// SELECT without (). Attach with:
//
//   ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION '…' [, apikey 'KEY']);

// Value imports from the workerd-safe facade (see schemas.ts) so this module —
// shared by the stdio, HTTP, and Cloudflare entries — bundles for the edge.
import {
  type CatalogAttachResult,
  type CatalogDescriptor,
  type CatalogInfo,
  type FunctionRegistry,
  ReadOnlyCatalogInterface,
  serializeAttachOptionSpecs,
} from "vgi/worker-cf";

import { allWeatherFunctions } from "./functions.js";
import { WEATHER_MACROS } from "./macros.js";
import { ATTACH_OPTION_SPECS, encodeAttachOpaqueData } from "./attach-options.js";

export const DATA_VERSION = "1.0.0";
// `process` doesn't exist on workerd (Cloudflare); read it defensively so the
// same module loads on Bun/Node and the edge alike.
export const GIT_COMMIT =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VGI_OPEN_METEO_GIT_COMMIT || "unknown";

export const CATALOG_NAME = "open_meteo";

// ---------------------------------------------------------------------------
// Documentation tags (surfaced through DuckDB system tables; linted by
// vgi-lint against TAGS.md). Array/object-valued tags are JSON-encoded strings.
// ---------------------------------------------------------------------------

const CATALOG_DOC_LLM =
  "Open-Meteo is a free, high-resolution weather API. This catalog exposes it as SQL table " +
  "functions: point-based weather forecasts (hourly, daily and current), historical reanalysis " +
  "back to 1940, air-quality and pollutant levels, marine wave and swell conditions, river-discharge " +
  "flood outlooks, and downscaled climate-change projections. A geocoding search turns place names " +
  "into coordinates and an elevation lookup returns terrain height. Every function takes a " +
  "latitude/longitude (geocoding takes a name), returns timestamps in UTC, and accepts an optional " +
  "commercial API key at ATTACH time. Inline SQL macros decode the raw coded columns into labels " +
  "(weather_code to text/emoji, wind direction to compass points, AQI and UV to categories). Reach " +
  "for it to answer 'what is/was/will be the weather at this point' questions directly in SQL.";

const CATALOG_DOC_MD = [
  "## Open-Meteo weather for DuckDB",
  "",
  "[Open-Meteo](https://open-meteo.com) is a free, high-resolution weather API. This catalog wraps it",
  "as SQL table functions so you can query weather, climate and geospatial data directly from DuckDB.",
  "",
  "### What you can ask",
  "",
  "Point-based **forecasts** (hourly, daily, current), **historical** reanalysis back to 1940, " +
    "**air quality**, **marine** waves and swell, **flood** river-discharge, and downscaled **climate** " +
    "projections. A **geocoding** search maps place names to coordinates, and an **elevation** lookup " +
    "returns terrain height. Inline **decoding macros** turn raw coded columns into labels (weather " +
    "code → text/emoji, wind direction → compass, AQI and UV → categories).",
  "",
  "### Conventions",
  "",
  "Every function takes a `latitude`/`longitude` (geocoding takes a `name`). Timestamps are always " +
    "returned in UTC; a `timezone` argument only controls how daily aggregates are bucketed. Commercial " +
    "customers can pass an `apikey` at ATTACH time to use the paid endpoints.",
].join("\n");

const SCHEMA_DOC_LLM =
  "The main schema holds the full Open-Meteo function family. It groups point-based weather into " +
  "forecast (hourly/daily/current), historical reanalysis, air-quality, marine, flood and " +
  "climate-projection categories, plus two helpers: geocoding to resolve place names to coordinates " +
  "and elevation to look up terrain height. All functions share one calling convention — a WGS84 " +
  "latitude/longitude and named optional arguments (timezone, units, forecast_days, date ranges, " +
  "models) — and emit UTC timestamps. Query a single point per call and combine locations in SQL " +
  "with UNION ALL or a cross join over a coordinates table. The schema also provides inline SQL " +
  "decoding macros in its 'helpers' category — weather_code_text and weather_code_emoji (WMO code), " +
  "wind_compass (degrees to a 16-point compass), us_aqi_category / european_aqi_category, and " +
  "uv_index_category — that turn the raw coded columns into human-readable labels; call them " +
  "schema-qualified, e.g. weather_code_text(weather_code).";

const SCHEMA_DOC_MD = [
  "## Open-Meteo functions",
  "",
  "Point-based weather, climate and geospatial functions from [Open-Meteo](https://open-meteo.com), " +
    "organized into forecast, historical, air-quality, marine, flood and climate categories, plus " +
    "geocoding and elevation helpers.",
  "",
  "Every function shares one calling convention: a WGS84 `latitude`/`longitude` (geocoding takes a " +
    "`name`), named optional arguments, and UTC timestamps. To cover several places, read their " +
    "coordinates from `geocoding(...)` first, then call the weather functions for each — arguments must " +
    "be literals, so this is a two-step, not a correlated join.",
  "",
  "### Decoding helpers",
  "",
  "Several columns come back as raw codes. The schema's `helpers` category adds inline SQL macros " +
    "that decode them — `weather_code_text` / `weather_code_emoji`, `wind_compass`, " +
    "`us_aqi_category` / `european_aqi_category`, and `uv_index_category`. They expand inline (no " +
    "round-trip); call them schema-qualified alongside the functions (applying, say, " +
    "`weather_code_text` to the `weather_code` column). The browsable `weather_codes` view lists " +
    "every WMO code with its text and emoji. See each object's example queries for runnable SQL.",
].join("\n");

const SCHEMA_CATEGORIES = [
  { name: "forecast", title: "Weather Forecast", description: "Hourly, daily and current weather forecasts for a coordinate." },
  { name: "historical", title: "Historical Weather", description: "Reanalysis weather from 1940 to present (ERA5 archive)." },
  { name: "air-quality", title: "Air Quality", description: "Pollutant concentrations and AQI, current and forecast." },
  { name: "marine", title: "Marine", description: "Wave and swell forecasts for ocean points." },
  { name: "flood", title: "Flood", description: "River-discharge and flood outlooks." },
  { name: "climate", title: "Climate Projections", description: "Downscaled climate-change projections (1950 to 2050)." },
  { name: "geocoding", title: "Geocoding", description: "Place-name search returning coordinates." },
  { name: "reference", title: "Reference", description: "Terrain elevation and other coordinate lookups." },
  { name: "helpers", title: "Decoding Helpers", description: "SQL macros that translate raw codes (weather, wind, AQI, UV) into human-readable labels." },
];

// Analyst tasks for `vgi-lint simulate`. Between them the reference_sql exercises
// every function, macro, and the weather_codes view (VGI520 coverage).
const AGENT_TEST_TASKS = [
  {
    name: "berlin_current_conditions",
    prompt: "Describe the current weather in Berlin: temperature, a text summary, an emoji, and the wind direction as a compass point.",
    reference_sql:
      "SELECT temperature_2m, open_meteo.main.weather_code_text(weather_code) AS conditions, " +
      "open_meteo.main.weather_code_emoji(weather_code) AS icon, " +
      "open_meteo.main.wind_compass(wind_direction_10m) AS wind FROM open_meteo.main.forecast_current(52.52, 13.41)",
  },
  {
    name: "tokyo_geocode_daily",
    prompt: "Find the coordinates of Tokyo and return its daily high and low temperature for the next 3 days.",
    reference_sql: [
      "SELECT latitude, longitude FROM open_meteo.main.geocoding('Tokyo', count := 1)",
      "SELECT time, temperature_2m_max, temperature_2m_min FROM open_meteo.main.forecast_daily(35.6895, 139.6917, forecast_days := 3) ORDER BY time",
    ],
  },
  {
    name: "berlin_hourly_uv",
    prompt: "For the next day in Berlin, list the hourly UV index and its WHO risk category.",
    reference_sql:
      "SELECT time, uv_index, open_meteo.main.uv_index_category(uv_index) AS risk " +
      "FROM open_meteo.main.forecast_hourly(52.52, 13.41, forecast_days := 1) ORDER BY time",
  },
  {
    name: "everest_elevation",
    prompt: "What is the terrain elevation, in metres, at latitude 27.99 and longitude 86.93?",
    reference_sql: "SELECT elevation FROM open_meteo.main.elevation(27.99, 86.93)",
  },
  {
    name: "berlin_historical_week",
    prompt: "Get Berlin's daily maximum temperature for the first week of June 2024, and the hourly temperature for June 1st.",
    reference_sql: [
      "SELECT time, temperature_2m_max FROM open_meteo.main.historical_daily(52.52, 13.41, '2024-06-01', '2024-06-07') ORDER BY time",
      "SELECT time, temperature_2m FROM open_meteo.main.historical_hourly(52.52, 13.41, '2024-06-01', '2024-06-02') ORDER BY time",
    ],
  },
  {
    name: "la_air_quality_us",
    prompt: "What is the current US AQI in Los Angeles and its EPA health category?",
    reference_sql:
      "SELECT us_aqi, open_meteo.main.us_aqi_category(us_aqi) AS category " +
      "FROM open_meteo.main.air_quality_current(34.05, -118.24)",
  },
  {
    name: "berlin_air_quality_forecast_eu",
    prompt: "Forecast the European AQI band for Berlin over the next two days.",
    reference_sql:
      "SELECT time, european_aqi, open_meteo.main.european_aqi_category(european_aqi) AS band " +
      "FROM open_meteo.main.air_quality_hourly(52.52, 13.41, forecast_days := 2) ORDER BY time",
  },
  {
    name: "north_sea_marine",
    prompt: "Get the hourly wave height and the daily maximum wave height for a North Sea point (54.5, 8.0).",
    reference_sql: [
      "SELECT time, wave_height FROM open_meteo.main.marine_hourly(54.5, 8.0, forecast_days := 2) ORDER BY time",
      "SELECT time, wave_height_max FROM open_meteo.main.marine_daily(54.5, 8.0, forecast_days := 3) ORDER BY time",
    ],
  },
  {
    name: "berlin_flood_outlook",
    prompt: "What is the river-discharge (flood) outlook near Berlin over the coming weeks?",
    reference_sql:
      "SELECT time, river_discharge FROM open_meteo.main.flood_daily(52.52, 13.41, forecast_days := 30) ORDER BY time",
  },
  {
    name: "berlin_climate_projection",
    prompt: "Project Berlin's daily maximum temperature for the year 2040 under a downscaled climate model.",
    reference_sql:
      "SELECT time, temperature_2m_max FROM open_meteo.main.climate_daily(52.52, 13.41, '2040-01-01', '2040-12-31', models := 'MRI_AGCM3_2_S') ORDER BY time",
  },
  {
    name: "weather_codes_lookup",
    prompt: "List every WMO weather code with its text description and emoji.",
    reference_sql: "SELECT code, description, emoji FROM open_meteo.main.weather_codes ORDER BY code",
  },
];

const EXECUTABLE_EXAMPLES = [
  {
    name: "elevation_echoes_coordinate",
    description: "elevation() echoes the requested coordinate and adds terrain height.",
    sql: "SELECT latitude, longitude FROM open_meteo.main.elevation(52.52, 13.41)",
    expected_result: [{ latitude: 52.52, longitude: 13.41 }],
  },
];

const SCHEMA_EXAMPLE_QUERIES = [
  {
    description: "Current conditions in Berlin, weather code decoded to text.",
    sql: "SELECT temperature_2m, open_meteo.main.weather_code_text(weather_code) AS conditions FROM open_meteo.main.forecast_current(52.52, 13.41)",
  },
  {
    description: "Geocode a place name; its coordinates feed the forecast functions.",
    sql: "SELECT name, latitude, longitude FROM open_meteo.main.geocoding('Paris', count := 1)",
  },
];

// A browsable reference relation (view): the full WMO weather-code table. It
// gives agents/humans something to `SELECT *` without any arguments (VGI146),
// doubles as the lookup behind the weather_code_* macros, and can be JOINed to
// any forecast's weather_code column.
const WMO_CODES: Array<[number, string, string]> = [
  [0, "Clear sky", "☀️"], [1, "Mainly clear", "🌤️"], [2, "Partly cloudy", "⛅"],
  [3, "Overcast", "☁️"], [45, "Fog", "🌫️"], [48, "Depositing rime fog", "🌫️"],
  [51, "Light drizzle", "🌦️"], [53, "Moderate drizzle", "🌦️"], [55, "Dense drizzle", "🌦️"],
  [56, "Light freezing drizzle", "🌧️"], [57, "Dense freezing drizzle", "🌧️"],
  [61, "Slight rain", "🌧️"], [63, "Moderate rain", "🌧️"], [65, "Heavy rain", "🌧️"],
  [66, "Light freezing rain", "🌧️"], [67, "Heavy freezing rain", "🌧️"],
  [71, "Slight snowfall", "🌨️"], [73, "Moderate snowfall", "🌨️"], [75, "Heavy snowfall", "🌨️"],
  [77, "Snow grains", "🌨️"], [80, "Slight rain showers", "🌧️"], [81, "Moderate rain showers", "🌧️"],
  [82, "Violent rain showers", "🌧️"], [85, "Slight snow showers", "🌨️"], [86, "Heavy snow showers", "🌨️"],
  [95, "Thunderstorm", "⛈️"], [96, "Thunderstorm with slight hail", "⛈️"], [99, "Thunderstorm with heavy hail", "⛈️"],
];

const WEATHER_CODES_VIEW = {
  name: "weather_codes",
  definition:
    "SELECT * FROM (VALUES " +
    WMO_CODES.map(([c, d, e]) => `(${c}, '${d}', '${e}')`).join(", ") +
    ") AS t(code, description, emoji)",
  comment: "WMO 4677 weather-code reference: numeric code → text description and emoji.",
  columnComments: {
    code: "WMO 4677 weather-interpretation code (as returned by forecast/historical weather_code).",
    description: "Human-readable English description of the code.",
    emoji: "A representative weather emoji for the code.",
  },
  tags: {
    "vgi.category": "reference",
    "vgi.title": "WMO Weather Codes",
    domain: "weather",
    "vgi.keywords": JSON.stringify(["weather code", "wmo", "4677", "lookup", "reference"]),
    "vgi.doc_llm":
      "The full WMO 4677 weather-code lookup as a browsable table: one row per code with its English " +
      "description and a representative emoji. It backs the weather_code_text / weather_code_emoji " +
      "macros; JOIN it to a forecast's `weather_code` column, or SELECT it directly to see every code.",
    "vgi.doc_md":
      "## weather_codes\n\nThe complete WMO 4677 weather-code table (`code`, `description`, `emoji`). " +
      "Unlike the weather functions it needs no arguments, so it is directly browsable, and it is the " +
      "lookup behind the `weather_code_text` / `weather_code_emoji` macros. JOIN it to a forecast's " +
      "`weather_code` column, or query it on its own. See its example queries for runnable SQL.",
    "vgi.example_queries": JSON.stringify([
      {
        description: "Label a forecast by joining to the code table.",
        sql: "SELECT f.time, w.description, w.emoji FROM open_meteo.main.forecast_hourly(52.52, 13.41, forecast_days := 1) f JOIN open_meteo.main.weather_codes w ON w.code = f.weather_code ORDER BY f.time",
      },
    ]),
  },
};

const KEYWORDS = [
  "weather", "forecast", "temperature", "precipitation", "climate", "air quality",
  "marine", "waves", "flood", "geocoding", "elevation", "open-meteo",
];

export const openMeteoCatalog: CatalogDescriptor = {
  name: CATALOG_NAME,
  defaultSchema: "main",
  comment: "Weather, air-quality, marine, flood, climate, geocoding & elevation (Open-Meteo)",
  sourceUrl: "https://open-meteo.com",
  tags: {
    "vgi.title": "Open-Meteo Weather",
    "vgi.doc_llm": CATALOG_DOC_LLM,
    "vgi.doc_md": CATALOG_DOC_MD,
    "vgi.keywords": JSON.stringify(KEYWORDS),
    "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
    "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
    "vgi.author": "Query Farm (VGI port); weather data by Open-Meteo",
    "vgi.copyright": "Weather data © Open-Meteo, licensed CC BY 4.0",
    "vgi.license": "MIT",
    "vgi.support_contact": "https://github.com/open-meteo/open-meteo/issues",
    "vgi.support_policy_url": "https://open-meteo.com/en/terms",
  },
  schemas: [
    {
      name: "main",
      comment: "Open-Meteo weather, climate, air-quality, marine, flood, geocoding & elevation functions.",
      tags: {
        "vgi.title": "Open-Meteo Weather API",
        "vgi.doc_llm": SCHEMA_DOC_LLM,
        "vgi.doc_md": SCHEMA_DOC_MD,
        "vgi.keywords": JSON.stringify(KEYWORDS),
        "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
        "vgi.example_queries": JSON.stringify(SCHEMA_EXAMPLE_QUERIES),
        domain: "weather",
      },
      views: [WEATHER_CODES_VIEW],
      functions: allWeatherFunctions,
      macros: WEATHER_MACROS,
    },
  ],
};

/**
 * Catalog interface that advertises the optional `apikey` ATTACH option and
 * encodes the received options into attach_opaque_data so every table function
 * can read the key back out in process(). Mirrors vgi-typescript's
 * examples/attach-options-worker.ts.
 */
export class OpenMeteoCatalog extends ReadOnlyCatalogInterface {
  override catalogsInfo(): CatalogInfo[] {
    // Start from the base discovery record (which carries the descriptor's
    // source_url) and layer on the advertised attach option specs, so both the
    // apikey option AND source_url surface through vgi_catalogs().
    return super.catalogsInfo().map((info) => ({
      ...info,
      attach_option_specs: serializeAttachOptionSpecs(ATTACH_OPTION_SPECS),
    }));
  }

  override attach(
    name: string,
    options?: Record<string, unknown>,
    dataVersionSpec?: string | null,
    implementationVersion?: string | null,
  ): CatalogAttachResult | Promise<CatalogAttachResult> {
    const base = super.attach(name, options, dataVersionSpec, implementationVersion);
    if (base instanceof Promise) {
      return base.then((b) => ({ ...b, attach_opaque_data: encodeAttachOpaqueData(options ?? {}) }));
    }
    return { ...base, attach_opaque_data: encodeAttachOpaqueData(options ?? {}) };
  }
}

/** Build a FunctionRegistry populated with every weather function. */
export function buildRegistry(registry: FunctionRegistry): FunctionRegistry {
  for (const f of allWeatherFunctions) registry.register(f);
  return registry;
}
