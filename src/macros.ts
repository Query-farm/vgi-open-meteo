// SQL convenience macros for the open_meteo catalog.
//
// The block functions return several *raw coded numbers* straight from
// Open-Meteo — a WMO weather code, wind direction in degrees, US/European AQI,
// and a UV index — with no human-readable form. These macros translate each
// into a label. They are catalog *macros*, not table/scalar functions, so DuckDB
// expands them inline as plain SQL: zero RPC round-trips, no worker load, and
// they work identically on the stdio, HTTP, and Cloudflare transports.
//
// Call them schema-qualified, e.g.
//   SELECT temperature_2m, open_meteo.main.weather_code_text(weather_code)
//   FROM open_meteo.main.forecast_current(52.52, 13.41);

import type { MacroDescriptor } from "vgi";

const HELPERS = "helpers";

// WMO 4677 weather-interpretation code → English description.
const WEATHER_CODE_TEXT = `CASE code
  WHEN 0 THEN 'Clear sky'
  WHEN 1 THEN 'Mainly clear'
  WHEN 2 THEN 'Partly cloudy'
  WHEN 3 THEN 'Overcast'
  WHEN 45 THEN 'Fog'
  WHEN 48 THEN 'Depositing rime fog'
  WHEN 51 THEN 'Light drizzle'
  WHEN 53 THEN 'Moderate drizzle'
  WHEN 55 THEN 'Dense drizzle'
  WHEN 56 THEN 'Light freezing drizzle'
  WHEN 57 THEN 'Dense freezing drizzle'
  WHEN 61 THEN 'Slight rain'
  WHEN 63 THEN 'Moderate rain'
  WHEN 65 THEN 'Heavy rain'
  WHEN 66 THEN 'Light freezing rain'
  WHEN 67 THEN 'Heavy freezing rain'
  WHEN 71 THEN 'Slight snowfall'
  WHEN 73 THEN 'Moderate snowfall'
  WHEN 75 THEN 'Heavy snowfall'
  WHEN 77 THEN 'Snow grains'
  WHEN 80 THEN 'Slight rain showers'
  WHEN 81 THEN 'Moderate rain showers'
  WHEN 82 THEN 'Violent rain showers'
  WHEN 85 THEN 'Slight snow showers'
  WHEN 86 THEN 'Heavy snow showers'
  WHEN 95 THEN 'Thunderstorm'
  WHEN 96 THEN 'Thunderstorm with slight hail'
  WHEN 99 THEN 'Thunderstorm with heavy hail'
  ELSE 'Unknown (' || code || ')'
END`;

const WEATHER_CODE_EMOJI = `CASE
  WHEN code = 0 THEN '☀️'
  WHEN code = 1 THEN '🌤️'
  WHEN code = 2 THEN '⛅'
  WHEN code = 3 THEN '☁️'
  WHEN code IN (45, 48) THEN '🌫️'
  WHEN code IN (51, 53, 55, 56, 57) THEN '🌦️'
  WHEN code IN (61, 63, 65, 66, 67, 80, 81, 82) THEN '🌧️'
  WHEN code IN (71, 73, 75, 77, 85, 86) THEN '🌨️'
  WHEN code IN (95, 96, 99) THEN '⛈️'
  ELSE '❓'
END`;

// 16-point compass. DuckDB list indexing is 1-based and NULL-safe out of range,
// so a NULL bearing yields NULL. round(deg/22.5) maps to 0..16, %16 folds 16→0.
const WIND_COMPASS =
  "(ARRAY['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'])" +
  "[(CAST(round(degrees / 22.5) AS BIGINT) % 16) + 1]";

const US_AQI_CATEGORY = `CASE
  WHEN aqi IS NULL THEN NULL
  WHEN aqi <= 50 THEN 'Good'
  WHEN aqi <= 100 THEN 'Moderate'
  WHEN aqi <= 150 THEN 'Unhealthy for Sensitive Groups'
  WHEN aqi <= 200 THEN 'Unhealthy'
  WHEN aqi <= 300 THEN 'Very Unhealthy'
  ELSE 'Hazardous'
END`;

const EUROPEAN_AQI_CATEGORY = `CASE
  WHEN aqi IS NULL THEN NULL
  WHEN aqi <= 20 THEN 'Good'
  WHEN aqi <= 40 THEN 'Fair'
  WHEN aqi <= 60 THEN 'Moderate'
  WHEN aqi <= 80 THEN 'Poor'
  WHEN aqi <= 100 THEN 'Very Poor'
  ELSE 'Extremely Poor'
END`;

const UV_INDEX_CATEGORY = `CASE
  WHEN uv IS NULL THEN NULL
  WHEN uv < 3 THEN 'Low'
  WHEN uv < 6 THEN 'Moderate'
  WHEN uv < 8 THEN 'High'
  WHEN uv < 11 THEN 'Very High'
  ELSE 'Extreme'
END`;

/** Compact spec → a fully-documented scalar-macro descriptor. */
interface MacroSpec {
  name: string;
  param: string;
  paramDoc: string;
  definition: string;
  comment: string;
  keywords: string[];
  docLlm: string;
  docMd: string;
  /** Example that applies the macro to a real column (VGI513), not a literal. */
  example: { description: string; sql: string };
}

function scalarMacro(s: MacroSpec): MacroDescriptor {
  return {
    name: s.name,
    macroType: "scalar",
    parameters: [s.param],
    parameterDocs: { [s.param]: s.paramDoc },
    definition: s.definition,
    comment: s.comment,
    tags: {
      "vgi.category": HELPERS,
      "vgi.keywords": JSON.stringify(s.keywords),
      "vgi.doc_llm": s.docLlm,
      // Prose only — runnable queries live in vgi.example_queries, not in a
      // ```sql fence in the description (VGI179).
      "vgi.doc_md": [`## ${s.name}`, "", s.docMd].join("\n"),
      "vgi.example_queries": JSON.stringify([s.example]),
    },
  };
}

export const WEATHER_MACROS: MacroDescriptor[] = [
  scalarMacro({
    name: "weather_code_text",
    param: "code",
    paramDoc: "WMO weather-interpretation code from a forecast/historical function.",
    definition: WEATHER_CODE_TEXT,
    comment: "Translate a WMO weather_code into an English description (e.g. 61 → 'Slight rain').",
    keywords: ["weather code", "wmo", "condition", "description", "decode"],
    docLlm:
      "Maps a WMO 4677 weather_code (the raw number returned by forecast_* and historical_* " +
      "functions) to a short English description such as 'Clear sky', 'Slight rain' or " +
      "'Thunderstorm with heavy hail'. Expands inline as SQL — no round-trip. Unknown codes " +
      "return 'Unknown (<code>)'.",
    docMd:
      "Turns the raw WMO `weather_code` (an integer) into an English description. Apply it to " +
      "the `weather_code` column of any forecast or historical function; see this macro's example " +
      "queries for a runnable form.",
    example: {
      description: "Decode the current weather code to text.",
      sql: "SELECT weather_code, open_meteo.main.weather_code_text(weather_code) AS conditions FROM open_meteo.main.forecast_current(52.52, 13.41)",
    },
  }),
  scalarMacro({
    name: "weather_code_emoji",
    param: "code",
    paramDoc: "WMO weather-interpretation code from a forecast/historical function.",
    definition: WEATHER_CODE_EMOJI,
    comment: "Map a WMO weather_code to a representative weather emoji (e.g. 95 → ⛈️).",
    keywords: ["weather code", "wmo", "emoji", "icon", "condition"],
    docLlm:
      "Maps a WMO 4677 weather_code to a single representative weather emoji (☀️ clear, ⛅ partly " +
      "cloudy, 🌧️ rain, 🌨️ snow, ⛈️ thunderstorm, 🌫️ fog). Handy for compact, human-facing " +
      "dashboards. Unknown codes return ❓.",
    docMd:
      "Maps the raw WMO `weather_code` to one weather emoji — a compact companion to " +
      "`weather_code_text` for display. See this macro's example queries for a runnable form.",
    example: {
      description: "Weather emoji for the current conditions.",
      sql: "SELECT weather_code, open_meteo.main.weather_code_emoji(weather_code) AS icon FROM open_meteo.main.forecast_current(52.52, 13.41)",
    },
  }),
  scalarMacro({
    name: "wind_compass",
    param: "degrees",
    paramDoc: "Wind (or wave) bearing the flow comes from, in meteorological degrees.",
    definition: WIND_COMPASS,
    comment: "Convert a bearing in degrees to a 16-point compass abbreviation (e.g. 315 → 'NW').",
    keywords: ["wind", "direction", "bearing", "compass", "cardinal"],
    docLlm:
      "Converts a bearing in degrees (0–360, meteorological — the direction the flow comes from) " +
      "into a 16-point compass abbreviation like N, ENE or SW. Works for wind_direction_10m, the " +
      "daily dominant direction, and marine wave/swell directions. NULL in, NULL out.",
    docMd:
      "Converts a degree bearing to a 16-point compass point (`N`, `NNE`, … `NNW`). Apply it to a " +
      "`wind_direction_*` or wave-direction column; see this macro's example queries for a runnable form.",
    example: {
      description: "Current wind direction as a compass point.",
      sql: "SELECT wind_direction_10m, open_meteo.main.wind_compass(wind_direction_10m) AS from_dir FROM open_meteo.main.forecast_current(52.52, 13.41)",
    },
  }),
  scalarMacro({
    name: "us_aqi_category",
    param: "aqi",
    paramDoc: "US Air Quality Index value from an air_quality function (us_aqi column).",
    definition: US_AQI_CATEGORY,
    comment: "Bucket a US AQI value into its EPA category (e.g. 120 → 'Unhealthy for Sensitive Groups').",
    keywords: ["air quality", "aqi", "us aqi", "epa", "pollution"],
    docLlm:
      "Buckets a US Air Quality Index value (the us_aqi column from air_quality_* functions) into " +
      "its EPA category: Good, Moderate, Unhealthy for Sensitive Groups, Unhealthy, Very Unhealthy, " +
      "or Hazardous. NULL in, NULL out.",
    docMd:
      "Maps a US AQI number to its EPA health category. Apply it to the `us_aqi` column of an " +
      "air_quality function; see this macro's example queries for a runnable form.",
    example: {
      description: "US AQI category for current conditions in Los Angeles.",
      sql: "SELECT us_aqi, open_meteo.main.us_aqi_category(us_aqi) AS category FROM open_meteo.main.air_quality_current(34.05, -118.24)",
    },
  }),
  scalarMacro({
    name: "european_aqi_category",
    param: "aqi",
    paramDoc: "European Air Quality Index value from an air_quality function (european_aqi column).",
    definition: EUROPEAN_AQI_CATEGORY,
    comment: "Bucket a European AQI value into its CAMS band (e.g. 75 → 'Poor').",
    keywords: ["air quality", "aqi", "european aqi", "cams", "pollution"],
    docLlm:
      "Buckets a European Air Quality Index value (the european_aqi column from air_quality_* " +
      "functions) into its CAMS band: Good, Fair, Moderate, Poor, Very Poor, or Extremely Poor. " +
      "The European scale differs from the US one, so use the matching macro. NULL in, NULL out.",
    docMd:
      "Maps a European AQI number to its CAMS band (distinct from the US scale). Apply it to the " +
      "`european_aqi` column of an air_quality function; see this macro's example queries for a runnable form.",
    example: {
      description: "European AQI band for current conditions in Berlin.",
      sql: "SELECT european_aqi, open_meteo.main.european_aqi_category(european_aqi) AS band FROM open_meteo.main.air_quality_current(52.52, 13.41)",
    },
  }),
  scalarMacro({
    name: "uv_index_category",
    param: "uv",
    paramDoc: "UV index value from a forecast or air_quality function (uv_index column).",
    definition: UV_INDEX_CATEGORY,
    comment: "Bucket a UV index into its WHO exposure category (e.g. 9 → 'Very High').",
    keywords: ["uv", "uv index", "sun", "exposure", "who"],
    docLlm:
      "Buckets a UV index value (the uv_index column from forecast_* and air_quality_* functions) " +
      "into its WHO exposure category: Low, Moderate, High, Very High, or Extreme. NULL in, NULL out.",
    docMd:
      "Maps a UV index number to its WHO exposure-risk category. Apply it to the `uv_index` column " +
      "of a forecast or air_quality function; see this macro's example queries for a runnable form.",
    example: {
      description: "UV-index risk category over the next day of hourly forecast.",
      sql: "SELECT time, uv_index, open_meteo.main.uv_index_category(uv_index) AS risk FROM open_meteo.main.forecast_hourly(52.52, 13.41, forecast_days := 1) ORDER BY time",
    },
  }),
];
