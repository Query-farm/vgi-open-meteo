// Explicit fields, deliberate measures. Every physical output of a modeled
// endpoint is selectable; adding a column requires a reviewed definition here.
// Units and interval meanings follow the official sources linked in README.md.
import { contextFields, PROVENANCE_TAG } from "./provenance.js";
import { temporalTags } from "./temporal.js";

export const SEMANTIC_CATALOG_ID = "farm.query.open_meteo";

type Unit = { unit: string } | {
  unit_parameter: { argument: string; values: Record<string, string> };
};
type Filter = { member: string; operator: "gt"; value: number }
  | { member: string; operator: "is_not_null" }
  | { and: Filter[] };
type Member = {
  member_id: string;
  title: string;
  kind: "identifier" | "dimension" | "time_dimension" | "measure";
  description: string;
  column?: string;
  data_type?: string;
  source_argument?: string;
  hidden?: boolean;
  conformance_id?: string;
  timezone?: string;
  granularities?: string[];
  week_start?: "monday";
  aggregation?: "avg" | "min" | "max" | "sum" | "count" | "count_rows";
  member?: string;
  additivity?: "additive" | "non_additive";
  filter?: Filter;
} & Partial<Unit>;
type Argument = { argument: string; parameter: string; required?: false };

const temperature: Unit = {
  unit_parameter: { argument: "temperature_unit", values: { celsius: "Cel", fahrenheit: "[degF]" } },
};
const windSpeed: Unit = {
  unit_parameter: { argument: "wind_speed_unit", values: { kmh: "km/h", ms: "m/s", mph: "[mi_i]/h", kn: "[kn_i]" } },
};
const precipitation: Unit = {
  unit_parameter: { argument: "precipitation_unit", values: { mm: "mm", inch: "[in_i]" } },
};
const snowfall: Unit = {
  unit_parameter: { argument: "precipitation_unit", values: { mm: "cm", inch: "[in_i]" } },
};

// These helpers serialize explicit definitions; they never infer meaning,
// units or aggregation from a column name or numeric SQL type.
function field(name: string, title: string, data_type: string, description: string, unit?: Unit): Member {
  return { member_id: name, column: name, title, kind: "dimension", data_type, description, ...unit };
}
function measure(member_id: string, title: string, aggregation: NonNullable<Member["aggregation"]>, member: string, description: string): Member {
  return { member_id, title, kind: "measure", aggregation, member, description,
    ...(aggregation === "count" ? { unit: "1" } : {}),
    additivity: aggregation === "sum" || aggregation === "count" ? "additive" : "non_additive" };
}
function optional(argument: string): Argument {
  return { argument, parameter: argument, required: false };
}
const coordinates: Argument[] = [
  { argument: "latitude", parameter: "latitude" },
  { argument: "longitude", parameter: "longitude" },
];
const units: Argument[] = [optional("temperature_unit"), optional("wind_speed_unit"), optional("precipitation_unit")];
const forecastArguments: Argument[] = [...coordinates, optional("forecast_days"), optional("past_days"), optional("timezone"), optional("model"), ...units];
const historicalArguments: Argument[] = [
  ...coordinates,
  { argument: "start_date", parameter: "start_date" },
  { argument: "end_date", parameter: "end_date" },
  optional("timezone"), optional("model"), ...units,
];
const location: Member[] = [
  { member_id: "latitude", title: "Requested latitude", kind: "dimension", source_argument: "latitude", data_type: "DOUBLE", unit: "deg",
    conformance_id: `${SEMANTIC_CATALOG_ID}.requested_latitude`, description: "Requested WGS84 latitude in degrees north, retained per input location. This is not the provider's grid-cell coordinate." },
  { member_id: "longitude", title: "Requested longitude", kind: "dimension", source_argument: "longitude", data_type: "DOUBLE", unit: "deg",
    conformance_id: `${SEMANTIC_CATALOG_ID}.requested_longitude`, description: "Requested WGS84 longitude in degrees east, retained per input location. Use the driving site's identifier to distinguish sites sharing coordinates." },
];
const timeKey: Member = { member_id: "time_key", title: "Invocation row key", kind: "identifier", column: "time", data_type: "TIMESTAMP WITH TIME ZONE", hidden: true,
  description: "Row identity within one coordinate invocation. Driving location identifiers remain part of correlated query grain." };
const hourlyTime: Member = {
  member_id: "time", title: "Valid time (UTC)", kind: "time_dimension", column: "time", data_type: "TIMESTAMP WITH TIME ZONE",
  timezone: "UTC", granularities: ["hour", "day", "week", "month", "year"], week_start: "monday",
  conformance_id: `${SEMANTIC_CATALOG_ID}.utc_hour`,
  description: "UTC valid hour. Some fields describe this instant; amounts and averages can describe the preceding hour. Rollups group timestamp labels in UTC, not interval overlap. Use daily fields for provider daily totals.",
};
const currentTime: Member = { ...hourlyTime, title: "Current model time (UTC)", granularities: ["minute", "hour"], conformance_id: undefined,
  description: "UTC valid time of the current model estimate. This is not a station observation or a forecast issue time." };
const dailyTime = field("time", "Daily interval start (UTC)", "TIMESTAMP WITH TIME ZONE", "UTC start instant of the provider's daily interval. Select date for the provider's calendar label; this instant is not a UTC-day aggregate.");
const calendarDate = field("date", "Date in requested zone", "DATE", "Calendar label of the provider's daily interval in the requested zone (auto by default). The API holds one UTC offset across the response; intervals crossing a DST transition may differ from civil calendar days.");
const weatherCode = field("weather_code", "Weather condition code", "INTEGER", "WMO condition code. Follow the weather_codes relationship for its description and emoji. Codes are categories, not quantities.");

const hourlyFields: Member[] = [
  field("temperature_2m", "Air temperature (2 m)", "DOUBLE", "Air temperature at 2 metres at the valid time.", temperature),
  field("relative_humidity_2m", "Relative humidity (2 m)", "DOUBLE", "Relative humidity at 2 metres at the valid time.", { unit: "%" }),
  field("apparent_temperature", "Feels-like temperature", "DOUBLE", "Apparent temperature accounting for wind, humidity and radiation.", temperature),
  field("precipitation", "Hourly precipitation (water equivalent)", "DOUBLE", "Total rain, showers and snowfall water equivalent in the preceding hour. Snowfall depth must not be added to this amount.", precipitation),
  field("snowfall", "Hourly new snowfall depth", "DOUBLE", "New snow depth in the preceding hour, not settled snow depth or liquid-water equivalent.", snowfall),
  weatherCode,
  field("pressure_msl", "Sea-level pressure", "DOUBLE", "Air pressure reduced to mean sea level, rather than pressure at the ground.", { unit: "hPa" }),
  field("cloud_cover", "Total cloud cover", "DOUBLE", "Fraction of sky covered by clouds, expressed as a percentage.", { unit: "%" }),
  field("wind_speed_10m", "Wind speed (10 m)", "DOUBLE", "Modeled wind speed at 10 metres at the valid time; distinct from gust speed.", windSpeed),
  field("wind_direction_10m", "Wind direction (10 m)", "DOUBLE", "Direction FROM which wind blows, degrees clockwise from north. Arithmetic averaging is not a valid direction average.", { unit: "deg" }),
];
const hourlyMeasures: Member[] = [
  measure("average_temperature", "Mean hourly temperature", "avg", "temperature_2m", "Arithmetic mean of available hourly temperature samples at each location. Missing samples are excluded; interpolated samples can be present."),
  measure("highest_temperature", "Highest hourly temperature", "max", "temperature_2m", "Highest available hourly temperature at each location; extremes between samples can be missed."),
  measure("lowest_temperature", "Lowest hourly temperature", "min", "temperature_2m", "Lowest available hourly temperature at each location; extremes between samples can be missed."),
  measure("total_precipitation", "Total precipitation", "sum", "precipitation", "Sum of selected preceding-hour water-equivalent amounts at each location. Missing hours are excluded, not dry. This is not a regional total across sites."),
  measure("total_snowfall", "Total new snowfall depth", "sum", "snowfall", "Sum of new snowfall depths over the selected hourly intervals at each location, not the final snowpack depth."),
  measure("maximum_wind_speed", "Maximum wind speed", "max", "wind_speed_10m", "Maximum available wind-speed sample at each location."),
  measure("strongest_wind_gust", "Strongest wind gust", "max", "wind_gusts_10m", "Largest supplied gust value at each location. Its underlying interval follows the source model's gust definition."),
  measure("temperature_hours_with_data", "Hourly temperature samples available", "count", "temperature_2m", "Count of non-null hourly temperature samples. This does not measure precipitation coverage, observational independence or accuracy."),
  measure("precipitation_hours_with_data", "Hourly precipitation samples available", "count", "precipitation", "Count of non-null hourly precipitation amounts, including reported zero amounts. Not the number of wet hours."),
];
const dailyFields: Member[] = [
  calendarDate,
  { ...weatherCode, title: "Daily weather condition code", description: "Most severe WMO condition in the provider's daily interval. Follow weather_codes for readable conditions; do not average these codes." },
  field("temperature_2m_max", "Daily high temperature (2 m)", "DOUBLE", "Maximum air temperature in the provider's daily interval.", temperature),
  field("temperature_2m_min", "Daily low temperature (2 m)", "DOUBLE", "Minimum air temperature in the provider's daily interval.", temperature),
  field("apparent_temperature_max", "Daily high feels-like temperature", "DOUBLE", "Maximum apparent temperature in the provider's daily interval.", temperature),
  field("apparent_temperature_min", "Daily low feels-like temperature", "DOUBLE", "Minimum apparent temperature in the provider's daily interval.", temperature),
  field("sunrise", "Sunrise (UTC)", "TIMESTAMP WITH TIME ZONE", "Sunrise instant for the provider's date, in UTC. May be unavailable during polar day or night."),
  field("sunset", "Sunset (UTC)", "TIMESTAMP WITH TIME ZONE", "Sunset instant for the provider's date, in UTC. May be unavailable during polar day or night."),
  field("precipitation_sum", "Daily precipitation (water equivalent)", "DOUBLE", "Total rain, showers and snowfall water equivalent in the provider's daily interval.", precipitation),
  field("snowfall_sum", "Daily new snowfall depth", "DOUBLE", "Total new snowfall depth in the provider's daily interval; not water equivalent or final snowpack depth.", snowfall),
  field("precipitation_hours", "Hours with precipitation", "DOUBLE", "Provider count of wet hourly intervals in this day. This is not an exact duration of rainfall, and includes precipitation other than rain.", { unit: "h" }),
  field("wind_speed_10m_max", "Daily maximum wind speed (10 m)", "DOUBLE", "Maximum wind speed at 10 metres in the provider's daily interval.", windSpeed),
  field("wind_gusts_10m_max", "Daily strongest gust (10 m)", "DOUBLE", "Maximum wind gust at 10 metres in the provider's daily interval.", windSpeed),
  field("wind_direction_10m_dominant", "Daily dominant wind direction (10 m)", "DOUBLE", "Provider's dominant wind direction, FROM which wind blows, clockwise from north. Do not compute arithmetic averages of angles.", { unit: "deg" }),
  field("shortwave_radiation_sum", "Daily solar energy", "DOUBLE", "Global shortwave solar energy on a horizontal surface (direct plus diffuse) in the provider's daily interval. Energy (MJ/m²), not irradiance (W/m²).", { unit: "MJ/m2" }),
];
const dailyMeasures: Member[] = [
  measure("highest_temperature", "Highest daily high", "max", "temperature_2m_max", "Highest available daily high in the selected period at each location."),
  measure("lowest_temperature", "Lowest daily low", "min", "temperature_2m_min", "Lowest available daily low in the selected period at each location."),
  measure("total_precipitation", "Total precipitation", "sum", "precipitation_sum", "Sum of available daily water-equivalent precipitation amounts at each location. Missing days are excluded, not dry; not a regional total across sites."),
  measure("total_snowfall", "Total new snowfall depth", "sum", "snowfall_sum", "Sum of new snowfall depths over selected days at each location, not final snowpack depth."),
  measure("total_precipitation_hours", "Total hours with precipitation", "sum", "precipitation_hours", "Sum of provider wet-hour counts over selected days at each location, not exact rain duration."),
  measure("strongest_wind_gust", "Strongest wind gust", "max", "wind_gusts_10m_max", "Strongest reported daily gust in the selected period at each location."),
  { member_id: "days_with_precipitation", title: "Days with any reported precipitation", kind: "measure", aggregation: "count_rows", additivity: "additive", unit: "1",
    filter: { member: "precipitation_sum", operator: "gt", value: 0 }, description: "Count of days with reported precipitation greater than zero. Missing values are excluded. This is not a climatological wet-day index with a fixed millimetre threshold." },
  measure("precipitation_days_with_data", "Daily precipitation samples available", "count", "precipitation_sum", "Count of days with a precipitation amount, including zero. Other variables may have different coverage."),
  { member_id: "temperature_days_with_data", title: "Days with both temperature extremes", kind: "measure", aggregation: "count_rows", additivity: "additive", unit: "1",
    filter: { and: [{ member: "temperature_2m_max", operator: "is_not_null" }, { member: "temperature_2m_min", operator: "is_not_null" }] },
    description: "Count of days where both high and low temperature are available. This does not establish coverage of other variables." },
];
const airQualityFields: Member[] = [
  field("pm10", "PM10 concentration", "DOUBLE", "Near-surface particulate concentration for particles up to 10 micrometres.", { unit: "ug/m3" }),
  field("pm2_5", "PM2.5 concentration", "DOUBLE", "Near-surface fine particulate concentration for particles up to 2.5 micrometres.", { unit: "ug/m3" }),
  field("carbon_monoxide", "Carbon monoxide concentration", "DOUBLE", "Near-surface modeled CO concentration.", { unit: "ug/m3" }),
  field("nitrogen_dioxide", "Nitrogen dioxide concentration", "DOUBLE", "Near-surface modeled NO₂ concentration.", { unit: "ug/m3" }),
  field("sulphur_dioxide", "Sulphur dioxide concentration", "DOUBLE", "Near-surface modeled SO₂ concentration.", { unit: "ug/m3" }),
  field("ozone", "Ozone concentration", "DOUBLE", "Near-surface modeled ozone concentration, not total-column ozone.", { unit: "ug/m3" }),
  field("dust", "Dust concentration", "DOUBLE", "Near-surface modeled dust concentration.", { unit: "ug/m3" }),
  field("uv_index", "UV index", "DOUBLE", "Modeled UV radiation index. This is not a pollutant concentration.", { unit: "1" }),
  field("european_aqi", "European Air Quality Index", "INTEGER", "Provider European AQI, on a different scale from US AQI. Use the provider's index rather than recomputing it from a single concentration sample.", { unit: "1" }),
  field("us_aqi", "US Air Quality Index", "INTEGER", "Provider US AQI, on a different scale from European AQI. Pollutant-specific averaging periods are already part of the provider's calculation.", { unit: "1" }),
];

function entityTags(entity_id: string, title: string, description: string, grain: string[], members: Member[], args?: Argument[], defaultTime?: string): Record<string, string> {
  return {
    "vgi.semantic_entity": JSON.stringify({ entity_id, title, description, grain,
      ...(args ? { source: { arguments: args } } : {}), ...(defaultTime ? { default_time_dimension: defaultTime } : {}) }),
    "vgi.semantic_members": JSON.stringify(members),
  };
}
function weatherEntity(id: string, title: string, description: string, args: Argument[], members: Member[], time: Member): Record<string, string> {
  const context = contextFields(id).map(f => field(f.name, f.title, f.type, f.description, "unit" in f ? { unit: f.unit } : undefined));
  const tags = entityTags(id, title, description, ["time_key"], [timeKey, ...location, time, ...members, ...context], args,
    time.kind === "time_dimension" ? time.member_id : undefined);
  Object.assign(tags, temporalTags(id), { "open_meteo.provenance": PROVENANCE_TAG });
  if (members.some(member => member.member_id === "weather_code")) {
    tags["vgi.semantic_relationships"] = JSON.stringify([{
      relationship_id: `${SEMANTIC_CATALOG_ID}.${id}.conditions`,
      description: "Optional WMO lookup; an unknown or missing code must not remove weather rows.",
      from: { catalog_id: SEMANTIC_CATALOG_ID, entity_id: id },
      to: { catalog_id: SEMANTIC_CATALOG_ID, entity_id: "weather_codes" },
      from_cardinality: { min: 0, max: "many" }, to_cardinality: { min: 0, max: 1 },
      predicate: [{ from_member: "weather_code", to_member: "code" }],
    }]);
  }
  return tags;
}
const historicalNote = "Historical model estimates, not station observations. The best_match default can blend forecast-model and reanalysis products; select model = era5 for a consistent reanalysis product. Requires an inclusive start_date/end_date range.";
const WEATHER_ENTITIES: Record<string, Record<string, string>> = {
  forecast_current: weatherEntity("forecast_current", "Weather now", "Latest modeled conditions, normally based on 15-minute data which may be interpolated. The provider supplies the current aggregation duration. Select snapshot values directly; there are no period aggregates.", [...coordinates, optional("model"), ...units], [
    field("temperature_2m", "Current air temperature (2 m)", "DOUBLE", "Current modeled air temperature at 2 metres.", temperature),
    field("relative_humidity_2m", "Current relative humidity (2 m)", "DOUBLE", "Current modeled relative humidity at 2 metres.", { unit: "%" }),
    field("apparent_temperature", "Current feels-like temperature", "DOUBLE", "Current apparent temperature including wind, humidity and radiation effects.", temperature),
    field("is_day", "Daylight", "BOOLEAN", "Whether the location is in daylight at the current valid time."),
    field("precipitation", "Current interval precipitation", "DOUBLE", "Total precipitation water equivalent over the preceding interval_seconds (normally 15 minutes). Bounds come from the provider's current.interval; modeled values may be interpolated.", precipitation),
    weatherCode,
    field("cloud_cover", "Current cloud cover", "DOUBLE", "Current fraction of sky covered by clouds, expressed as a percentage.", { unit: "%" }),
    field("pressure_msl", "Current sea-level pressure", "DOUBLE", "Current pressure reduced to mean sea level, rather than pressure at the ground.", { unit: "hPa" }),
    field("wind_speed_10m", "Current wind speed (10 m)", "DOUBLE", "Current modeled wind speed at 10 metres, distinct from gust speed.", windSpeed),
    field("wind_direction_10m", "Current wind direction (10 m)", "DOUBLE", "Direction FROM which wind blows, clockwise from north. Angles must not be averaged arithmetically.", { unit: "deg" }),
    field("wind_gusts_10m", "Current modeled gust (10 m)", "DOUBLE", "Modeled gust at the current valid time; temporal support depends on the source, and values may be interpolated from coarser model intervals.", windSpeed),
  ], currentTime),
  forecast_hourly: weatherEntity("forecast_hourly", "Hourly forecast", "All returned hourly weather fields, with deliberate period measures. Use daily forecasts for the provider's daily totals and extremes.", forecastArguments, [
    ...hourlyFields,
    field("dew_point_2m", "Dew point (2 m)", "DOUBLE", "Modeled dew-point temperature at 2 metres at the valid time.", temperature),
    field("precipitation_probability", "Hourly precipitation probability", "DOUBLE", "Provider probability of precipitation over the preceding hour, using a nominal 0.1 mm/hour water-equivalent threshold. Calculation can use coarser ensemble intervals and interpolation. It is not a period probability and does not necessarily come from the selected deterministic model.", { unit: "%" }),
    field("rain", "Hourly large-scale rain", "DOUBLE", "Large-scale rain in the preceding hour. Convective showers are separate in forecast data; use precipitation for all precipitation types.", precipitation),
    field("wind_gusts_10m", "Hourly maximum gust (10 m)", "DOUBLE", "Maximum wind gust at 10 metres during the preceding hour.", windSpeed),
    field("visibility", "Visibility", "DOUBLE", "Modeled horizontal visibility at the valid time.", { unit: "m" }),
    field("uv_index", "UV index", "DOUBLE", "Modeled UV radiation index at this hour. Temporal support depends on the source and solar interpolation; hourly cadence does not establish an instantaneous value.", { unit: "1" }),
    field("is_day", "Daylight", "BOOLEAN", "Whether the location is in daylight at the valid time."),
    ...hourlyMeasures,
    measure("minimum_visibility", "Minimum visibility", "min", "visibility", "Lowest available hourly visibility at each location."),
    measure("maximum_uv_index", "Maximum UV index", "max", "uv_index", "Highest available hourly UV index in the selected period."),
    measure("maximum_hourly_precipitation_probability", "Highest hourly precipitation probability", "max", "precipitation_probability", "Largest supplied hourly probability in the selected period. This is not the probability of precipitation anywhere in the whole period; hours are not independent."),
    measure("precipitation_probability_hours_with_data", "Hourly probability samples available", "count", "precipitation_probability", "Count of non-null hourly probabilities, including reported zero probability. This does not measure coverage of precipitation amounts."),
  ], hourlyTime),
  forecast_daily: weatherEntity("forecast_daily", "Daily forecast", "All returned daily fields. Dates follow the provider's fixed-offset intervals in the requested zone (auto by default), which may differ from civil days across DST changes. Select date for daily results or omit it for a period summary.", forecastArguments, [
    ...dailyFields,
    field("rain_sum", "Daily large-scale rain", "DOUBLE", "Large-scale rain in the provider's daily interval. Convective showers are separate; use precipitation_sum for all precipitation types.", precipitation),
    ...dailyMeasures,
  ], dailyTime),
  historical_hourly: weatherEntity("historical_hourly", "Hourly historical weather", historicalNote + " Hourly time grouping uses UTC.", historicalArguments, [
    ...hourlyFields,
    field("dew_point_2m", "Dew point (2 m)", "DOUBLE", "Dew-point temperature at 2 metres at the valid time.", temperature),
    field("rain", "Hourly rain including showers", "DOUBLE", "Liquid precipitation including showers during the preceding hour. Archive rain differs from forecast large-scale rain.", precipitation),
    field("surface_pressure", "Surface pressure", "DOUBLE", "Air pressure at the modeled ground elevation; not reduced to sea level.", { unit: "hPa" }),
    field("wind_gusts_10m", "Modeled gust (10 m)", "DOUBLE", "Modeled wind gust at the indicated hour. Temporal support varies by source model; not uniformly a preceding-hour maximum.", windSpeed),
    field("shortwave_radiation", "Hourly mean solar irradiance", "DOUBLE", "Mean global shortwave irradiance on a horizontal surface (direct plus diffuse) over the preceding hour. W/m² is power per area; do not sum it and label the result as energy.", { unit: "W/m2" }),
    ...hourlyMeasures,
  ], hourlyTime),
  historical_daily: weatherEntity("historical_daily", "Daily historical weather", historicalNote + " Dates label the provider's fixed-offset days; DST transitions within a response are not applied.", historicalArguments, [
    ...dailyFields,
    field("rain_sum", "Daily rain including showers", "DOUBLE", "Liquid precipitation including showers in the provider's daily interval. Archive rain differs from forecast large-scale rain.", precipitation),
    ...dailyMeasures,
  ], dailyTime),
  air_quality_current: weatherEntity("air_quality_current", "Air quality now", "All returned current air-quality fields. Current values come from hourly modeled data; these are not station measurements. US and European AQI use different scales.", coordinates, airQualityFields, currentTime),
  air_quality_hourly: weatherEntity("air_quality_hourly", "Air quality forecast", "All returned hourly air-quality fields. Peak AQI is the largest supplied index in the period, not a recomputed regulatory daily index.", [...coordinates, optional("forecast_days"), optional("past_days"), optional("timezone")], [
    ...airQualityFields,
    measure("maximum_us_aqi", "Maximum US AQI", "max", "us_aqi", "Highest supplied hourly US AQI in the selected period, not a recomputed daily index."),
    measure("maximum_european_aqi", "Maximum European AQI", "max", "european_aqi", "Highest supplied hourly European AQI in the selected period, not a recomputed daily index."),
    measure("average_pm2_5", "Mean PM2.5 concentration", "avg", "pm2_5", "Mean of available hourly PM2.5 concentrations. Missing samples are excluded."),
    measure("pm2_5_hours_with_data", "Hourly PM2.5 samples available", "count", "pm2_5", "Number of supplied non-null PM2.5 samples, including interpolated values; does not establish AQI coverage."),
  ], hourlyTime),
};

export function weatherSemanticTags(name: string): Record<string, string> {
  return WEATHER_ENTITIES[name] ?? {};
}

export const GEOCODING_SEMANTIC_TAGS = entityTags("geocoding", "Places", "Resolve a place name, confirm its region and country, then pass its coordinates to weather. Use count = 1 only when the intended place is unambiguous.", ["id"], [
  { member_id: "id", title: "Location ID", kind: "identifier", column: "id", data_type: "BIGINT", description: "Stable GeoNames location identifier." },
  field("name", "Place name", "VARCHAR", "Matched place name."),
  field("latitude", "Latitude", "DOUBLE", "WGS84 latitude to pass to a weather function.", { unit: "deg" }),
  field("longitude", "Longitude", "DOUBLE", "WGS84 longitude to pass to a weather function.", { unit: "deg" }),
  field("elevation", "Place elevation", "DOUBLE", "Reported place elevation above sea level, where available.", { unit: "m" }),
  field("feature_code", "Place feature code", "VARCHAR", "GeoNames classification of the place, such as a populated place or administrative area."),
  field("country_code", "Country code", "VARCHAR", "ISO two-letter country code."),
  field("country", "Country", "VARCHAR", "Country name."),
  field("admin1", "State or region", "VARCHAR", "First-level administrative area; useful for disambiguating place names."),
  field("admin2", "County or district", "VARCHAR", "Second-level administrative area, where available."),
  field("admin3", "Local administrative area", "VARCHAR", "Third-level administrative area, where available."),
  field("admin4", "Fourth-level administrative area", "VARCHAR", "Fourth-level administrative area, where available."),
  field("timezone", "Place timezone", "VARCHAR", "IANA timezone of the matched place."),
  field("population", "Population", "BIGINT", "Reported population, where available.", { unit: "1" }),
  field("postcodes", "Postal codes", "VARCHAR[]", "Postal codes associated with the matched place, where available."),
], [{ argument: "name", parameter: "name" }, optional("count"), optional("country_code")]);

export const ELEVATION_SEMANTIC_TAGS = entityTags("elevation", "Terrain elevation", "Terrain height at the requested coordinate, not building height.", ["latitude", "longitude"], [
  { member_id: "latitude", title: "Latitude", kind: "identifier", column: "latitude", data_type: "DOUBLE", description: "Requested WGS84 latitude in degrees north." },
  { member_id: "longitude", title: "Longitude", kind: "identifier", column: "longitude", data_type: "DOUBLE", description: "Requested WGS84 longitude in degrees east." },
  field("elevation", "Terrain elevation", "DOUBLE", "Ground elevation above sea level from the 90 metre terrain model.", { unit: "m" }),
], coordinates);

export const WEATHER_CODES_SEMANTIC_TAGS = entityTags("weather_codes", "Weather conditions", "Readable conditions and emoji for WMO weather codes. Linked to current, hourly and daily weather.", ["code"], [
  { member_id: "code", title: "Weather condition code", kind: "identifier", column: "code", data_type: "INTEGER", description: "Unique WMO weather interpretation code." },
  field("description", "Weather conditions", "VARCHAR", "English description such as Clear sky or Slight rain."),
  field("emoji", "Weather emoji", "VARCHAR", "Representative weather emoji."),
]);
