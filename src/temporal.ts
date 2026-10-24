// Worker-specific, versioned metadata alongside the standard VGI members.
// VGI's member schema has no reporting-support field. Consumers can inspect
// this tag without receiving unsupported properties inside semantic_members.
type Support = {
  support: "instant" | "preceding_interval" | "provider_day" | "event_time" | "source_dependent";
  time_member: string;
  statistic?: "sum" | "mean" | "minimum" | "maximum" | "probability" | "dominant" | "count" | "most_severe";
  duration_seconds?: number;
  duration_member?: string;
  start_member?: string;
  end_member?: string;
  nominal_threshold?: { quantity: string; value: number; unit: string };
  note?: string;
};
const instant: Support = { support: "instant", time_member: "time" };
const uncertain: Support = { support: "source_dependent", time_member: "time" };
const window = (support: "preceding_interval" | "provider_day", statistic: Support["statistic"], seconds?: number): Support => ({
  support, time_member: "time", statistic,
  start_member: "interval_start", end_member: "interval_end",
  ...(seconds === undefined ? { duration_member: "interval_seconds" } : { duration_seconds: seconds }),
});
const hourly: Record<string, Support> = {
  temperature_2m: instant, relative_humidity_2m: instant, apparent_temperature: instant,
  dew_point_2m: instant, weather_code: instant, pressure_msl: instant,
  cloud_cover: instant, wind_speed_10m: instant, wind_direction_10m: instant,
  precipitation: window("preceding_interval", "sum", 3600),
  rain: window("preceding_interval", "sum", 3600),
  snowfall: window("preceding_interval", "sum", 3600),
};
const daily: Record<string, Support> = {
  temperature_2m_max: window("provider_day", "maximum", 86400),
  temperature_2m_min: window("provider_day", "minimum", 86400),
  apparent_temperature_max: window("provider_day", "maximum", 86400),
  apparent_temperature_min: window("provider_day", "minimum", 86400),
  precipitation_sum: window("provider_day", "sum", 86400),
  rain_sum: window("provider_day", "sum", 86400),
  snowfall_sum: window("provider_day", "sum", 86400),
  precipitation_hours: window("provider_day", "count", 86400),
  wind_speed_10m_max: window("provider_day", "maximum", 86400),
  wind_gusts_10m_max: window("provider_day", "maximum", 86400),
  wind_direction_10m_dominant: window("provider_day", "dominant", 86400),
  shortwave_radiation_sum: window("provider_day", "sum", 86400),
  weather_code: window("provider_day", "most_severe", 86400),
  sunrise: { support: "event_time", time_member: "sunrise" },
  sunset: { support: "event_time", time_member: "sunset" },
};
const uv: Support = { ...uncertain, note: "UV temporal support depends on the source and solar interpolation; hourly output cadence is not proof of an instantaneous value." };
const aq: Record<string, Support> = {
  pm10: instant, pm2_5: instant, carbon_monoxide: instant, nitrogen_dioxide: instant,
  sulphur_dioxide: instant, ozone: instant, dust: instant, uv_index: uv,
  european_aqi: { ...uncertain, note: "Provider index with pollutant-specific averaging periods." },
  us_aqi: { ...uncertain, note: "Provider index with pollutant-specific averaging periods." },
};
const definitions: Record<string, Record<string, Support>> = {
  forecast_hourly: {
    ...hourly, visibility: instant, is_day: instant, uv_index: uv,
    wind_gusts_10m: window("preceding_interval", "maximum", 3600),
    precipitation_probability: {
      ...window("preceding_interval", "probability", 3600),
      nominal_threshold: { quantity: "precipitation_water_equivalent", value: 0.1, unit: "mm" },
      note: "Nominal hourly threshold; source-native calculation and interpolation can differ. Hourly probabilities are not independent and must not be summed or multiplied into a period probability.",
    },
  },
  historical_hourly: {
    ...hourly, surface_pressure: instant,
    shortwave_radiation: window("preceding_interval", "mean", 3600),
    wind_gusts_10m: { ...uncertain, note: "Archive gust support varies by model; no universal preceding-hour maximum is asserted." },
  },
  forecast_daily: daily,
  historical_daily: daily,
  forecast_current: {
    temperature_2m: instant, relative_humidity_2m: instant, apparent_temperature: instant,
    is_day: instant, weather_code: instant, cloud_cover: instant, pressure_msl: instant,
    wind_speed_10m: instant, wind_direction_10m: instant,
    precipitation: window("preceding_interval", "sum"),
    wind_gusts_10m: { ...uncertain, note: "Current gusts can be interpolated from coarser model intervals." },
  },
  air_quality_current: aq,
  air_quality_hourly: aq,
};

export function temporalTags(name: string): Record<string, string> {
  const members = definitions[name];
  return members ? { "open_meteo.temporal": JSON.stringify({ version: 1, members }) } : {};
}
