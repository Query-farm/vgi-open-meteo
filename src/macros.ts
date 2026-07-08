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

// WMO 4677 weather-interpretation code → English description. Shared by the
// text and emoji macros' docs.
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

export const WEATHER_MACROS: MacroDescriptor[] = [
  {
    name: "weather_code_text",
    macroType: "scalar",
    parameters: ["code"],
    parameterDocs: { code: "WMO weather-interpretation code from a forecast/historical function." },
    definition: WEATHER_CODE_TEXT,
    comment: "Translate a WMO weather_code into an English description (e.g. 61 → 'Slight rain').",
    tags: {
      "vgi.category": HELPERS,
      "vgi.keywords": JSON.stringify(["weather code", "wmo", "condition", "description", "decode"]),
      "vgi.doc_llm":
        "Maps a WMO 4677 weather_code (the raw number returned by forecast_* and historical_* " +
        "functions) to a short English description such as 'Clear sky', 'Slight rain' or " +
        "'Thunderstorm with heavy hail'. Expands inline as SQL — no round-trip. Unknown codes " +
        "return 'Unknown (<code>)'.",
      "vgi.doc_md": [
        "## weather_code_text",
        "",
        "Turns the raw WMO `weather_code` (an integer) into an English description.",
        "",
        "```sql",
        "SELECT time, temperature_2m, open_meteo.main.weather_code_text(weather_code) AS conditions",
        "FROM open_meteo.main.forecast_hourly(52.52, 13.41)",
        "ORDER BY time;",
        "```",
      ].join("\n"),
      "vgi.example_queries": JSON.stringify([
        {
          description: "Decode the current weather code to text.",
          sql: "SELECT open_meteo.main.weather_code_text(61) AS conditions",
        },
      ]),
    },
  },
  {
    name: "weather_code_emoji",
    macroType: "scalar",
    parameters: ["code"],
    parameterDocs: { code: "WMO weather-interpretation code from a forecast/historical function." },
    definition: WEATHER_CODE_EMOJI,
    comment: "Map a WMO weather_code to a representative weather emoji (e.g. 95 → ⛈️).",
    tags: {
      "vgi.category": HELPERS,
      "vgi.keywords": JSON.stringify(["weather code", "wmo", "emoji", "icon", "condition"]),
      "vgi.doc_llm":
        "Maps a WMO 4677 weather_code to a single representative weather emoji (☀️ clear, ⛅ partly " +
        "cloudy, 🌧️ rain, 🌨️ snow, ⛈️ thunderstorm, 🌫️ fog). Handy for compact, human-facing " +
        "dashboards. Unknown codes return ❓.",
      "vgi.doc_md": [
        "## weather_code_emoji",
        "",
        "Maps the raw WMO `weather_code` to one weather emoji — a compact companion to " +
          "`weather_code_text` for display.",
        "",
        "```sql",
        "SELECT open_meteo.main.weather_code_emoji(weather_code) AS icon,",
        "       open_meteo.main.weather_code_text(weather_code)  AS conditions",
        "FROM open_meteo.main.forecast_current(52.52, 13.41);",
        "```",
      ].join("\n"),
      "vgi.example_queries": JSON.stringify([
        {
          description: "Weather emoji for a thunderstorm code.",
          sql: "SELECT open_meteo.main.weather_code_emoji(95) AS icon",
        },
      ]),
    },
  },
  {
    name: "wind_compass",
    macroType: "scalar",
    parameters: ["degrees"],
    parameterDocs: { degrees: "Wind (or wave) bearing the flow comes from, in meteorological degrees." },
    definition: WIND_COMPASS,
    comment: "Convert a bearing in degrees to a 16-point compass abbreviation (e.g. 315 → 'NW').",
    tags: {
      "vgi.category": HELPERS,
      "vgi.keywords": JSON.stringify(["wind", "direction", "bearing", "compass", "cardinal"]),
      "vgi.doc_llm":
        "Converts a bearing in degrees (0–360, meteorological — the direction the flow comes from) " +
        "into a 16-point compass abbreviation like N, ENE or SW. Works for wind_direction_10m, the " +
        "daily dominant direction, and marine wave/swell directions. NULL in, NULL out.",
      "vgi.doc_md": [
        "## wind_compass",
        "",
        "Converts a degree bearing to a 16-point compass point (`N`, `NNE`, … `NNW`).",
        "",
        "```sql",
        "SELECT wind_speed_10m,",
        "       open_meteo.main.wind_compass(wind_direction_10m) AS from_dir",
        "FROM open_meteo.main.forecast_current(52.52, 13.41);",
        "```",
      ].join("\n"),
      "vgi.example_queries": JSON.stringify([
        {
          description: "315 degrees is a north-westerly.",
          sql: "SELECT open_meteo.main.wind_compass(315) AS compass",
        },
      ]),
    },
  },
  {
    name: "us_aqi_category",
    macroType: "scalar",
    parameters: ["aqi"],
    parameterDocs: { aqi: "US Air Quality Index value from an air_quality function (us_aqi column)." },
    definition: US_AQI_CATEGORY,
    comment: "Bucket a US AQI value into its EPA category (e.g. 120 → 'Unhealthy for Sensitive Groups').",
    tags: {
      "vgi.category": HELPERS,
      "vgi.keywords": JSON.stringify(["air quality", "aqi", "us aqi", "epa", "pollution"]),
      "vgi.doc_llm":
        "Buckets a US Air Quality Index value (the us_aqi column from air_quality_* functions) into " +
        "its EPA category: Good, Moderate, Unhealthy for Sensitive Groups, Unhealthy, Very Unhealthy, " +
        "or Hazardous. NULL in, NULL out.",
      "vgi.doc_md": [
        "## us_aqi_category",
        "",
        "Maps a US AQI number to its EPA health category.",
        "",
        "```sql",
        "SELECT us_aqi, open_meteo.main.us_aqi_category(us_aqi) AS category",
        "FROM open_meteo.main.air_quality_current(34.05, -118.24);",
        "```",
      ].join("\n"),
      "vgi.example_queries": JSON.stringify([
        {
          description: "A US AQI of 120 is unhealthy for sensitive groups.",
          sql: "SELECT open_meteo.main.us_aqi_category(120) AS category",
        },
      ]),
    },
  },
  {
    name: "european_aqi_category",
    macroType: "scalar",
    parameters: ["aqi"],
    parameterDocs: { aqi: "European Air Quality Index value from an air_quality function (european_aqi column)." },
    definition: EUROPEAN_AQI_CATEGORY,
    comment: "Bucket a European AQI value into its CAMS band (e.g. 75 → 'Poor').",
    tags: {
      "vgi.category": HELPERS,
      "vgi.keywords": JSON.stringify(["air quality", "aqi", "european aqi", "cams", "pollution"]),
      "vgi.doc_llm":
        "Buckets a European Air Quality Index value (the european_aqi column from air_quality_* " +
        "functions) into its CAMS band: Good, Fair, Moderate, Poor, Very Poor, or Extremely Poor. " +
        "The European scale differs from the US one, so use the matching macro. NULL in, NULL out.",
      "vgi.doc_md": [
        "## european_aqi_category",
        "",
        "Maps a European AQI number to its CAMS band (distinct from the US scale).",
        "",
        "```sql",
        "SELECT european_aqi, open_meteo.main.european_aqi_category(european_aqi) AS band",
        "FROM open_meteo.main.air_quality_current(52.52, 13.41);",
        "```",
      ].join("\n"),
      "vgi.example_queries": JSON.stringify([
        {
          description: "A European AQI of 75 is poor.",
          sql: "SELECT open_meteo.main.european_aqi_category(75) AS band",
        },
      ]),
    },
  },
  {
    name: "uv_index_category",
    macroType: "scalar",
    parameters: ["uv"],
    parameterDocs: { uv: "UV index value from a forecast or air_quality function (uv_index column)." },
    definition: UV_INDEX_CATEGORY,
    comment: "Bucket a UV index into its WHO exposure category (e.g. 9 → 'Very High').",
    tags: {
      "vgi.category": HELPERS,
      "vgi.keywords": JSON.stringify(["uv", "uv index", "sun", "exposure", "who"]),
      "vgi.doc_llm":
        "Buckets a UV index value (the uv_index column from forecast_* and air_quality_* functions) " +
        "into its WHO exposure category: Low, Moderate, High, Very High, or Extreme. NULL in, NULL out.",
      "vgi.doc_md": [
        "## uv_index_category",
        "",
        "Maps a UV index number to its WHO exposure-risk category.",
        "",
        "```sql",
        "SELECT uv_index, open_meteo.main.uv_index_category(uv_index) AS risk",
        "FROM open_meteo.main.forecast_hourly(52.52, 13.41);",
        "```",
      ].join("\n"),
      "vgi.example_queries": JSON.stringify([
        {
          description: "A UV index of 9 is very high.",
          sql: "SELECT open_meteo.main.uv_index_category(9) AS risk",
        },
      ]),
    },
  },
];
