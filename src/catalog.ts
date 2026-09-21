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
import {
  SEMANTIC_CATALOG_ID,
  WEATHER_CODES_SEMANTIC_TAGS,
} from "./semantic.js";

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
  "models) — and emit UTC timestamps. Positional arguments accept columns, so use a LATERAL join " +
  "over a bounded coordinates table for multi-location queries or to chain geocoding into weather. " +
  "The schema also provides inline SQL " +
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
    "`name`), named optional arguments, and UTC timestamps. Positional arguments may be columns: use " +
    "a bounded `LATERAL` join for several locations, or chain `geocoding(...)` directly into a weather " +
    "function in one query.",
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
  { name: "ensemble", title: "Ensemble Forecast", description: "Control run plus perturbed members, giving the forecast distribution rather than a single value." },
  { name: "previous-runs", title: "Previous Runs", description: "Forecasts from successive earlier model runs, for scoring forecast skill by lead time." },
  { name: "geocoding", title: "Geocoding", description: "Place-name search returning coordinates." },
  { name: "reference", title: "Reference", description: "Terrain elevation and other coordinate lookups." },
  { name: "helpers", title: "Decoding Helpers", description: "SQL macros that translate raw codes (weather, wind, AQI, UV) into human-readable labels." },
];

// Public analyst prompts for `vgi-lint simulate`. Expected queries and tool
// requirements live in vgi-agent-tests.yaml so agents never see their graders.
const AGENT_TEST_TASKS = [
  {
    name: "berlin_current_conditions",
    prompt: "Describe the current weather in Berlin: temperature, a text summary, an emoji, and the wind direction as a compass point.",
  },
  {
    name: "tokyo_geocode_daily",
    prompt: "Find the coordinates of Tokyo and return its daily high and low temperature for the next 3 days.",
  },
  {
    name: "berlin_hourly_uv",
    prompt: "For the next day in Berlin, list the hourly UV index and its WHO risk category.",
  },
  {
    name: "everest_elevation",
    prompt: "What is the terrain elevation, in metres, at latitude 27.99 and longitude 86.93?",
  },
  {
    name: "berlin_historical_week",
    prompt: "Get Berlin's daily maximum temperature for the first week of June 2024, and the hourly temperature for June 1st.",
  },
  {
    name: "la_air_quality_us",
    prompt: "What is the current US AQI in Los Angeles and its EPA health category?",
  },
  {
    name: "berlin_air_quality_forecast_eu",
    prompt: "Forecast the European AQI band for Berlin over the next two days.",
  },
  {
    name: "north_sea_marine",
    prompt: "Get the hourly wave height and the daily maximum wave height for a North Sea point (54.5, 8.0).",
  },
  {
    name: "berlin_flood_outlook",
    prompt: "What is the river-discharge (flood) outlook near Berlin over the coming weeks?",
  },
  {
    name: "berlin_climate_projection",
    prompt: "Project Berlin's daily maximum temperature for the year 2040 under a downscaled climate model.",
  },
  {
    name: "weather_codes_lookup",
    prompt: "List every WMO weather code with its text description and emoji.",
  },
  {
    name: "berlin_ensemble_spread",
    prompt: "Compare the control and first ensemble-member temperature forecasts for Berlin, hourly and daily.",
  },
  {
    name: "berlin_previous_runs",
    prompt: "Compare Berlin's latest hourly temperature forecast with forecasts made one and three days earlier.",
  },
  {
    name: "multi_location_average_temperature",
    prompt: "For Berlin and Tokyo, return average hourly temperature by location and UTC hour for the next day using the semantic model.",
  },
  // The two below deliberately withhold coordinates: a person asking about the
  // weather names a place, so the analyst has to find the geocoding bridge
  // rather than be handed a latitude.
  {
    name: "scheveningen_marine_by_name",
    prompt: "How high are the waves at Scheveningen over the next two days? I don't know its coordinates.",
  },
  {
    name: "denver_elevation_by_name",
    prompt: "How far above sea level is Denver, in metres?",
  },
];

const EXECUTABLE_EXAMPLES = [
  {
    name: "elevation_echoes_coordinate",
    description: "elevation() echoes the requested coordinate and adds terrain height.",
    sql: "SELECT latitude, longitude FROM open_meteo.main.elevation(52.52, 13.41)",
    expected_result: [{ latitude: 52.52, longitude: 13.41 }],
  },
  {
    name: "geocoding_resolves_place_name",
    description:
      "geocoding() turns a place name into the coordinate the weather functions want — the " +
      "starting point for anyone who has a city rather than a latitude.",
    sql: "SELECT name, country_code FROM open_meteo.main.geocoding('Tokyo', count := 1)",
    expected_result: [{ name: "Tokyo", country_code: "JP" }],
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
  {
    description: "The usual starting point: a place name joined straight through to its current weather.",
    sql:
      "SELECT g.name, w.temperature_2m, open_meteo.main.weather_code_text(w.weather_code) AS conditions " +
      "FROM open_meteo.main.geocoding('Paris', count := 1) AS g, " +
      "LATERAL open_meteo.main.forecast_current(g.latitude, g.longitude) AS w",
  },
  {
    description: "A column of place names geocoded and forecast in one query.",
    sql:
      "SELECT p.city, d.time, d.temperature_2m_max FROM (VALUES ('Berlin'), ('Tokyo')) AS p(city), " +
      "LATERAL open_meteo.main.geocoding(p.city, count := 1) AS g, " +
      "LATERAL open_meteo.main.forecast_daily(g.latitude, g.longitude, forecast_days := 3) AS d " +
      "ORDER BY p.city, d.time",
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
      {
        description: "Same, for a place named rather than located: geocode, forecast, then label.",
        sql:
          "SELECT g.name, f.time, w.description, w.emoji " +
          "FROM open_meteo.main.geocoding('Oslo', count := 1) AS g, " +
          "LATERAL open_meteo.main.forecast_hourly(g.latitude, g.longitude, forecast_days := 1) AS f " +
          "JOIN open_meteo.main.weather_codes w ON w.code = f.weather_code ORDER BY f.time",
      },
      {
        description: "Browse the lookup on its own — no arguments needed.",
        sql: "SELECT code, description, emoji FROM open_meteo.main.weather_codes ORDER BY code",
      },
    ]),
    ...WEATHER_CODES_SEMANTIC_TAGS,
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
    "vgi.semantic_catalog": JSON.stringify({
      catalog_id: SEMANTIC_CATALOG_ID,
      binding_key: "open_meteo",
      title: "Open-Meteo Weather",
      description:
        "Point weather, climate, air-quality, marine, geocoding, and terrain data from Open-Meteo.",
      default_timezone: "UTC",
    }),
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
