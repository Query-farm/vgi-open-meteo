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
  "commercial API key at ATTACH time. Reach for it to answer 'what is/was/will be the weather at " +
  "this point' questions directly in SQL.";

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
    "returns terrain height.",
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
  "with UNION ALL or a cross join over a coordinates table.";

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
];

const AGENT_TEST_TASKS = [
  {
    name: "berlin_current_temp",
    prompt: "What is the current air temperature in Berlin, Germany?",
    reference_sql: "SELECT temperature_2m FROM open_meteo.main.forecast_current(52.52, 13.41)",
  },
  {
    name: "tokyo_3day_forecast",
    prompt: "Find the coordinates of Tokyo and return its daily high and low temperature for the next 3 days.",
    reference_sql: [
      "SELECT latitude, longitude FROM open_meteo.main.geocoding('Tokyo', count := 1)",
      "SELECT time, temperature_2m_max, temperature_2m_min FROM open_meteo.main.forecast_daily(35.6895, 139.6917, forecast_days := 3)",
    ],
  },
  {
    name: "everest_elevation",
    prompt: "What is the terrain elevation, in metres, at latitude 27.99 and longitude 86.93?",
    reference_sql: "SELECT elevation FROM open_meteo.main.elevation(27.99, 86.93)",
  },
  {
    name: "la_air_quality",
    prompt: "What is the current US air-quality index for Los Angeles (34.05, -118.24)?",
    reference_sql: "SELECT us_aqi FROM open_meteo.main.air_quality_current(34.05, -118.24)",
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
    description: "Current conditions in Berlin.",
    sql: "SELECT * FROM open_meteo.main.forecast_current(52.52, 13.41)",
  },
  {
    description: "Geocode a place name; its coordinates feed the forecast functions.",
    sql: "SELECT name, latitude, longitude FROM open_meteo.main.geocoding('Paris', count := 1)",
  },
];

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
      functions: allWeatherFunctions,
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
