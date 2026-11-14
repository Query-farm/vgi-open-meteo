// Composed example queries: two or more of this catalog's functions (and its
// decoding macros) combined in one query, the way an analyst actually asks
// weather questions — "is the air clean when it is dry?", "what does the wind
// do to the waves?". Every per-function generated example shows one endpoint in
// isolation; these show the joins between them.
//
// Each SQL string is defined once here and referenced from two places: the
// example list of the function that drives the query (functions.ts splices it
// in near the top, inside the first five the agent simulator shows), and the
// schema-level `vgi.example_queries` list (catalog.ts).

export interface ComposedExample {
  description: string;
  sql: string;
}

/** forecast_hourly ⋈ air_quality_hourly on the shared UTC hour, AQI decoded. */
export const DRY_CLEAN_AIR_HOURS: ComposedExample = {
  description:
    "Planning an outdoor run: the dry hours of Berlin's next two days, cleanest air first — the " +
    "hourly weather forecast joined to the air-quality forecast on the same UTC hour, with the " +
    "European AQI decoded to its band.",
  sql:
    "SELECT w.time, w.temperature_2m, a.european_aqi, " +
    "open_meteo.main.european_aqi_category(a.european_aqi) AS air_quality " +
    "FROM open_meteo.main.forecast_hourly(52.52, 13.41, forecast_days := 2) AS w " +
    "JOIN open_meteo.main.air_quality_hourly(52.52, 13.41, forecast_days := 2) AS a ON a.time = w.time " +
    "WHERE w.precipitation = 0 ORDER BY a.european_aqi, w.time LIMIT 10",
};

/** geocoding → marine_hourly ⋈ forecast_hourly at the same point, wind decoded. */
export const SURF_CHECK: ComposedExample = {
  description:
    "Surf check for a beach named rather than located: geocode Scheveningen once, then line up its " +
    "hourly wave height and period with the land forecast's wind speed and compass direction at " +
    "the same point.",
  sql:
    "SELECT m.time, m.wave_height, m.wave_period, f.wind_speed_10m, " +
    "open_meteo.main.wind_compass(f.wind_direction_10m) AS wind_from " +
    "FROM open_meteo.main.geocoding('Scheveningen', count := 1) AS g, " +
    "LATERAL open_meteo.main.marine_hourly(g.latitude, g.longitude, forecast_days := 2) AS m " +
    "JOIN open_meteo.main.forecast_hourly(g.latitude, g.longitude, forecast_days := 2) AS f ON f.time = m.time " +
    "ORDER BY m.time",
};

/** forecast_daily ⋈ ensemble_daily: the single forecast against the members' range. */
export const FORECAST_VS_ENSEMBLE: ComposedExample = {
  description:
    "How sure is the forecast? Berlin's best-match daily high for the next 5 local days next to " +
    "the lowest and highest of the GFS ensemble members — days where the forecast high falls " +
    "outside that range disagree with the whole ensemble.",
  sql:
    "SELECT f.date, f.temperature_2m_max AS forecast_high, " +
    "list_min(list_value(*COLUMNS('temperature_2m_max_member\\d+'))) AS members_low, " +
    "list_max(list_value(*COLUMNS('temperature_2m_max_member\\d+'))) AS members_high " +
    "FROM open_meteo.main.forecast_daily(52.52, 13.41, forecast_days := 5, timezone := 'auto') AS f " +
    "JOIN open_meteo.main.ensemble_daily(52.52, 13.41, forecast_days := 5, timezone := 'auto') AS e ON e.date = f.date " +
    "ORDER BY f.date",
};

/** forecast_daily ⋈ historical_daily one year back, dates computed per run. */
export const FORECAST_VS_LAST_YEAR: ComposedExample = {
  description:
    "This week against the same week last year: Berlin's daily forecast high joined to the " +
    "reanalysis high for the same calendar date one year earlier (the archive window is computed " +
    "from today, so the query never needs editing).",
  sql:
    "SELECT f.date, f.temperature_2m_max AS forecast_high, h.temperature_2m_max AS last_year_high, " +
    "round(f.temperature_2m_max - h.temperature_2m_max, 1) AS warmer_by " +
    "FROM open_meteo.main.forecast_daily(52.52, 13.41, forecast_days := 7) AS f " +
    "JOIN open_meteo.main.historical_daily(52.52, 13.41, " +
    "strftime(current_date - INTERVAL 1 YEAR - INTERVAL 1 DAY, '%Y-%m-%d'), " +
    "strftime(current_date - INTERVAL 1 YEAR + INTERVAL 8 DAY, '%Y-%m-%d')) AS h " +
    "ON h.date = CAST(f.date - INTERVAL 1 YEAR AS DATE) ORDER BY f.date",
};

/** Composed examples keyed by the function whose example list leads with them. */
export const COMPOSED_EXAMPLES_BY_FUNCTION: Record<string, ComposedExample[]> = {
  air_quality_hourly: [DRY_CLEAN_AIR_HOURS],
  marine_hourly: [SURF_CHECK],
  ensemble_daily: [FORECAST_VS_ENSEMBLE],
  forecast_daily: [FORECAST_VS_LAST_YEAR],
};

/** Every composed example, for the schema-level list. */
export const COMPOSED_EXAMPLES: ComposedExample[] = [
  DRY_CLEAN_AIR_HOURS,
  SURF_CHECK,
  FORECAST_VS_ENSEMBLE,
  FORECAST_VS_LAST_YEAR,
];
