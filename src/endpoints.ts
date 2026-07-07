// Endpoint configuration for the Open-Meteo "block" table functions.
//
// Every Open-Meteo weather endpoint returns the same shape: a `hourly` /
// `daily` / `current` block of parallel arrays (or, for `current`, scalars)
// keyed by `time`. That uniformity lets one generator (defineWeatherFunction in
// functions.ts) drive all of them — each function is just an EndpointConfig:
// host + path + which block + a fixed, curated list of variables + which
// request arguments it accepts. Mirrors how the old code used TripConfig.

export type BlockKind = "hourly" | "daily" | "current";

/** A weather variable = one output column. `kind` picks the Arrow type. */
export interface WeatherVar {
  name: string;
  kind: "double" | "int" | "bool" | "timestamp";
}

const d = (name: string): WeatherVar => ({ name, kind: "double" });
const i = (name: string): WeatherVar => ({ name, kind: "int" });
const b = (name: string): WeatherVar => ({ name, kind: "bool" });
const ts = (name: string): WeatherVar => ({ name, kind: "timestamp" });

/** Which request arguments (beyond latitude/longitude) a function accepts. */
export interface EndpointArgs {
  /** forecast_days + past_days (relative range). */
  forecastDays?: boolean;
  /** start_date + end_date — required positional args (archive / climate). */
  dateRange?: boolean;
  /** timezone (defaults to GMT). */
  timezone?: boolean;
  /** temperature_unit / wind_speed_unit / precipitation_unit. */
  units?: boolean;
  /** models (comma-separated). */
  models?: boolean;
}

export interface EndpointConfig {
  name: string;
  description: string;
  host: string;
  path: string;
  block: BlockKind;
  variables: WeatherVar[];
  args: EndpointArgs;
  categories: string[];
  /** Primary `vgi.category` slug — must be a name in the schema's category registry. */
  category: string;
  /** Cache TTL (ms). Forecasts are short-lived; archives are effectively static. */
  cacheTtlMs: number;
  /** Default for forecast_days when args.forecastDays is set. */
  defaultForecastDays?: number;
  /** Default models string (climate needs at least one). */
  defaultModels?: string;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Curated variable lists (fixed columns per function)
// ---------------------------------------------------------------------------

const FORECAST_HOURLY: WeatherVar[] = [
  d("temperature_2m"),
  d("relative_humidity_2m"),
  d("apparent_temperature"),
  d("precipitation"),
  d("rain"),
  d("snowfall"),
  i("weather_code"),
  d("pressure_msl"),
  d("cloud_cover"),
  d("visibility"),
  d("wind_speed_10m"),
  d("wind_direction_10m"),
  d("wind_gusts_10m"),
  d("uv_index"),
  b("is_day"),
];

// Archive (ERA5) exposes a narrower hourly variable set than the forecast API
// — notably no visibility / uv_index / is_day — and 400s on unknown variables.
const ARCHIVE_HOURLY: WeatherVar[] = [
  d("temperature_2m"),
  d("relative_humidity_2m"),
  d("dew_point_2m"),
  d("apparent_temperature"),
  d("precipitation"),
  d("rain"),
  d("snowfall"),
  i("weather_code"),
  d("pressure_msl"),
  d("surface_pressure"),
  d("cloud_cover"),
  d("wind_speed_10m"),
  d("wind_direction_10m"),
  d("wind_gusts_10m"),
  d("shortwave_radiation"),
];

const DAILY: WeatherVar[] = [
  i("weather_code"),
  d("temperature_2m_max"),
  d("temperature_2m_min"),
  d("apparent_temperature_max"),
  d("apparent_temperature_min"),
  ts("sunrise"),
  ts("sunset"),
  d("precipitation_sum"),
  d("rain_sum"),
  d("snowfall_sum"),
  d("precipitation_hours"),
  d("wind_speed_10m_max"),
  d("wind_gusts_10m_max"),
  d("wind_direction_10m_dominant"),
  d("shortwave_radiation_sum"),
];

const CURRENT: WeatherVar[] = [
  d("temperature_2m"),
  d("relative_humidity_2m"),
  d("apparent_temperature"),
  b("is_day"),
  d("precipitation"),
  i("weather_code"),
  d("cloud_cover"),
  d("pressure_msl"),
  d("wind_speed_10m"),
  d("wind_direction_10m"),
  d("wind_gusts_10m"),
];

const AIR_QUALITY: WeatherVar[] = [
  d("pm10"),
  d("pm2_5"),
  d("carbon_monoxide"),
  d("nitrogen_dioxide"),
  d("sulphur_dioxide"),
  d("ozone"),
  d("dust"),
  d("uv_index"),
  i("european_aqi"),
  i("us_aqi"),
];

const MARINE_HOURLY: WeatherVar[] = [
  d("wave_height"),
  d("wave_direction"),
  d("wave_period"),
  d("wind_wave_height"),
  d("wind_wave_direction"),
  d("wind_wave_period"),
  d("swell_wave_height"),
  d("swell_wave_direction"),
  d("swell_wave_period"),
];

const MARINE_DAILY: WeatherVar[] = [
  d("wave_height_max"),
  d("wave_direction_dominant"),
  d("wave_period_max"),
  d("wind_wave_height_max"),
  d("swell_wave_height_max"),
];

const FLOOD_DAILY: WeatherVar[] = [d("river_discharge")];

const CLIMATE_DAILY: WeatherVar[] = [
  d("temperature_2m_max"),
  d("temperature_2m_min"),
  d("temperature_2m_mean"),
  d("precipitation_sum"),
  d("rain_sum"),
  d("snowfall_sum"),
  d("wind_speed_10m_max"),
  d("shortwave_radiation_sum"),
];

// ---------------------------------------------------------------------------
// Endpoint configs
// ---------------------------------------------------------------------------

export const ENDPOINTS: EndpointConfig[] = [
  {
    name: "forecast_hourly",
    description: "Hourly weather forecast (up to 16 days) for a coordinate.",
    host: "api.open-meteo.com",
    path: "/v1/forecast",
    block: "hourly",
    variables: FORECAST_HOURLY,
    args: { forecastDays: true, timezone: true, units: true, models: true },
    categories: ["weather", "forecast"],
    category: "forecast",
    cacheTtlMs: 10 * MIN,
    defaultForecastDays: 7,
  },
  {
    name: "forecast_daily",
    description: "Daily weather forecast (up to 16 days) for a coordinate.",
    host: "api.open-meteo.com",
    path: "/v1/forecast",
    block: "daily",
    variables: DAILY,
    args: { forecastDays: true, timezone: true, units: true, models: true },
    categories: ["weather", "forecast"],
    category: "forecast",
    cacheTtlMs: 10 * MIN,
    defaultForecastDays: 7,
  },
  {
    name: "forecast_current",
    description: "Current weather conditions for a coordinate.",
    host: "api.open-meteo.com",
    path: "/v1/forecast",
    block: "current",
    variables: CURRENT,
    args: { timezone: true, units: true },
    categories: ["weather", "realtime"],
    category: "forecast",
    cacheTtlMs: 5 * MIN,
  },
  {
    name: "historical_hourly",
    description: "Hourly historical/reanalysis weather (1940→present) for a coordinate.",
    host: "archive-api.open-meteo.com",
    path: "/v1/archive",
    block: "hourly",
    variables: ARCHIVE_HOURLY,
    args: { dateRange: true, timezone: true, units: true },
    categories: ["weather", "historical"],
    category: "historical",
    cacheTtlMs: DAY,
  },
  {
    name: "historical_daily",
    description: "Daily historical/reanalysis weather (1940→present) for a coordinate.",
    host: "archive-api.open-meteo.com",
    path: "/v1/archive",
    block: "daily",
    variables: DAILY,
    args: { dateRange: true, timezone: true, units: true },
    categories: ["weather", "historical"],
    category: "historical",
    cacheTtlMs: DAY,
  },
  {
    name: "air_quality_hourly",
    description: "Hourly air-quality (pollutants + AQI) forecast for a coordinate.",
    host: "air-quality-api.open-meteo.com",
    path: "/v1/air-quality",
    block: "hourly",
    variables: AIR_QUALITY,
    args: { forecastDays: true, timezone: true },
    categories: ["weather", "air-quality"],
    category: "air-quality",
    cacheTtlMs: 30 * MIN,
    defaultForecastDays: 5,
  },
  {
    name: "air_quality_current",
    description: "Current air-quality (pollutants + AQI) for a coordinate.",
    host: "air-quality-api.open-meteo.com",
    path: "/v1/air-quality",
    block: "current",
    variables: AIR_QUALITY,
    args: { timezone: true },
    categories: ["weather", "air-quality", "realtime"],
    category: "air-quality",
    cacheTtlMs: 30 * MIN,
  },
  {
    name: "marine_hourly",
    description: "Hourly marine forecast (wave/swell) for a coordinate.",
    host: "marine-api.open-meteo.com",
    path: "/v1/marine",
    block: "hourly",
    variables: MARINE_HOURLY,
    args: { forecastDays: true, timezone: true },
    categories: ["weather", "marine"],
    category: "marine",
    cacheTtlMs: 30 * MIN,
    defaultForecastDays: 7,
  },
  {
    name: "marine_daily",
    description: "Daily marine forecast (wave/swell maxima) for a coordinate.",
    host: "marine-api.open-meteo.com",
    path: "/v1/marine",
    block: "daily",
    variables: MARINE_DAILY,
    args: { forecastDays: true, timezone: true },
    categories: ["weather", "marine"],
    category: "marine",
    cacheTtlMs: 30 * MIN,
    defaultForecastDays: 7,
  },
  {
    name: "flood_daily",
    description: "Daily river-discharge / flood forecast for a coordinate.",
    host: "flood-api.open-meteo.com",
    path: "/v1/flood",
    block: "daily",
    variables: FLOOD_DAILY,
    args: { forecastDays: true },
    categories: ["weather", "flood"],
    category: "flood",
    cacheTtlMs: HOUR,
    defaultForecastDays: 30,
  },
  {
    name: "climate_daily",
    description: "Daily downscaled climate-change projections (1950→2050) for a coordinate.",
    host: "climate-api.open-meteo.com",
    path: "/v1/climate",
    block: "daily",
    variables: CLIMATE_DAILY,
    args: { dateRange: true, timezone: true, models: true },
    categories: ["weather", "climate"],
    category: "climate",
    cacheTtlMs: DAY,
    defaultModels: "MRI_AGCM3_2_S",
  },
];
