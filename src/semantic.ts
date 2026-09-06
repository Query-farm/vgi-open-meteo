// VGI semantic-model metadata for the Open-Meteo catalog.
//
// DuckDB 1.5 does not expose tags on table-function output columns, so members
// are carried as the packed `vgi.semantic_members` array on each function.
// Function invocation edges (input -> geocoding -> forecast) are deliberately
// represented by source arguments, not semantic relationships.

import type { EndpointConfig, WeatherVar } from "./endpoints.js";

export const SEMANTIC_CATALOG_ID = "farm.query.open_meteo";

type SemanticMember = Record<string, unknown>;

const TEMPERATURE_UNITS = {
  argument: "temperature_unit",
  values: { celsius: "Cel", fahrenheit: "[degF]" },
};

const WIND_SPEED_UNITS = {
  argument: "wind_speed_unit",
  values: { kmh: "km/h", ms: "m/s", mph: "[mi_i]/h", kn: "[kn_i]" },
};

const PRECIPITATION_UNITS = {
  argument: "precipitation_unit",
  values: { mm: "mm", inch: "[in_i]" },
};

const SNOWFALL_UNITS = {
  argument: "precipitation_unit",
  values: { mm: "cm", inch: "[in_i]" },
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function title(name: string): string {
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function dataType(variable: WeatherVar): string {
  switch (variable.kind) {
    case "double":
      return "DOUBLE";
    case "int":
      return "INTEGER";
    case "bool":
      return "BOOLEAN";
    case "timestamp":
      return "TIMESTAMP WITH TIME ZONE";
  }
}

function sourceArguments(config: EndpointConfig): Record<string, unknown>[] {
  const mappings: Record<string, unknown>[] = [
    { argument: "latitude", parameter: "latitude" },
    { argument: "longitude", parameter: "longitude" },
  ];
  if (config.args.dateRange) {
    mappings.push(
      { argument: "start_date", parameter: "start_date" },
      { argument: "end_date", parameter: "end_date" },
    );
  }
  if (config.args.forecastDays) {
    mappings.push(
      {
        argument: "forecast_days",
        parameter: "forecast_days",
        required: false,
      },
      { argument: "past_days", parameter: "past_days", required: false },
    );
  }
  if (config.args.timezone) {
    mappings.push({
      argument: "timezone",
      parameter: "timezone",
      required: false,
    });
  }
  if (config.args.units) {
    mappings.push(
      {
        argument: "temperature_unit",
        parameter: "temperature_unit",
        required: false,
      },
      {
        argument: "wind_speed_unit",
        parameter: "wind_speed_unit",
        required: false,
      },
      {
        argument: "precipitation_unit",
        parameter: "precipitation_unit",
        required: false,
      },
    );
  }
  if (config.args.models) {
    mappings.push({ argument: "models", parameter: "models", required: false });
  }
  return mappings;
}

function timeGranularities(
  block: EndpointConfig["block"],
): Array<"minute" | "hour" | "day" | "week" | "month" | "quarter" | "year"> {
  if (block === "daily") return ["day", "week", "month", "quarter", "year"];
  if (block === "hourly")
    return ["hour", "day", "week", "month", "quarter", "year"];
  return ["minute", "hour", "day", "week", "month", "quarter", "year"];
}

function canAverage(variable: WeatherVar): boolean {
  return (
    (variable.kind === "double" || variable.kind === "int") &&
    !variable.name.includes("code") &&
    !variable.name.includes("direction")
  );
}

function physicalUnit(
  variable: WeatherVar,
  configurable: boolean,
): Record<string, unknown> {
  const name = variable.name;
  if (name.includes("temperature") || name.includes("dew_point")) {
    return configurable
      ? { unit_parameter: TEMPERATURE_UNITS }
      : { unit: "Cel" };
  }
  if (name.includes("wind_speed") || name.includes("wind_gusts")) {
    return configurable
      ? { unit_parameter: WIND_SPEED_UNITS }
      : { unit: "km/h" };
  }
  if (name.includes("snowfall")) {
    return configurable ? { unit_parameter: SNOWFALL_UNITS } : { unit: "cm" };
  }
  if (name.includes("precipitation") || name.includes("rain")) {
    return configurable
      ? { unit_parameter: PRECIPITATION_UNITS }
      : { unit: "mm" };
  }
  if (name.includes("relative_humidity") || name.includes("cloud_cover"))
    return { unit: "%" };
  if (name.includes("pressure")) return { unit: "hPa" };
  if (name === "visibility") return { unit: "m" };
  if (name.includes("direction")) return { unit: "deg" };
  if (name.includes("wave_height")) return { unit: "m" };
  if (name.includes("wave_period")) return { unit: "s" };
  if (name === "river_discharge") return { unit: "m3/s" };
  if (name === "precipitation_hours") return { unit: "h" };
  if (name.includes("shortwave_radiation"))
    return { unit: name.endsWith("_sum") ? "MJ/m2" : "W/m2" };
  if (
    name === "weather_code" ||
    name === "is_day" ||
    name.includes("aqi") ||
    name.includes("uv_index")
  )
    return { unit: "1" };
  if (
    [
      "pm10",
      "pm2_5",
      "carbon_monoxide",
      "nitrogen_dioxide",
      "sulphur_dioxide",
      "ozone",
      "dust",
    ].includes(name)
  )
    return { unit: "ug/m3" };
  return {};
}

function sourceArgumentMembers(config: EndpointConfig): SemanticMember[] {
  const members: SemanticMember[] = [
    {
      member_id: "requested_latitude",
      source_argument: "latitude",
      data_type: "DOUBLE",
      unit: "deg",
      description: "WGS84 latitude supplied to this function invocation.",
    },
    {
      member_id: "requested_longitude",
      source_argument: "longitude",
      data_type: "DOUBLE",
      unit: "deg",
      description: "WGS84 longitude supplied to this function invocation.",
    },
  ];
  if (config.args.dateRange) {
    members.push(
      {
        member_id: "requested_start_date",
        source_argument: "start_date",
        data_type: "VARCHAR",
        description:
          "Inclusive ISO date supplied as the start of the requested range.",
      },
      {
        member_id: "requested_end_date",
        source_argument: "end_date",
        data_type: "VARCHAR",
        description:
          "Inclusive ISO date supplied as the end of the requested range.",
      },
    );
  }
  if (config.args.forecastDays) {
    members.push(
      {
        member_id: "requested_forecast_days",
        source_argument: "forecast_days",
        data_type: "BIGINT",
        unit: "d",
        description:
          "Forecast horizon supplied to the invocation, or its function default.",
      },
      {
        member_id: "requested_past_days",
        source_argument: "past_days",
        data_type: "BIGINT",
        unit: "d",
        description:
          "Number of preceding days supplied to the invocation, or its function default.",
      },
    );
  }
  if (config.args.timezone) {
    members.push({
      member_id: "requested_timezone",
      source_argument: "timezone",
      data_type: "VARCHAR",
      description:
        "Timezone option supplied to the invocation, or its function default.",
    });
  }
  if (config.args.units) {
    members.push(
      {
        member_id: "requested_temperature_unit",
        source_argument: "temperature_unit",
        data_type: "VARCHAR",
        description:
          "Temperature-unit option supplied to the invocation, or its function default.",
      },
      {
        member_id: "requested_wind_speed_unit",
        source_argument: "wind_speed_unit",
        data_type: "VARCHAR",
        description:
          "Wind-speed-unit option supplied to the invocation, or its function default.",
      },
      {
        member_id: "requested_precipitation_unit",
        source_argument: "precipitation_unit",
        data_type: "VARCHAR",
        description:
          "Precipitation-unit option supplied to the invocation, or its function default.",
      },
    );
  }
  if (config.args.models) {
    members.push({
      member_id: "requested_models",
      source_argument: "models",
      data_type: "VARCHAR",
      description:
        "Model selection supplied to the invocation, or its function default.",
    });
  }
  return members;
}

function weatherMembers(config: EndpointConfig): SemanticMember[] {
  const step =
    config.block === "daily"
      ? "day"
      : config.block === "hourly"
        ? "hour"
        : "instant";
  const granularities = timeGranularities(config.block);
  const members: SemanticMember[] = [
    {
      member_id: "time_key",
      kind: "identifier",
      column: "time",
      data_type: "TIMESTAMP WITH TIME ZONE",
      hidden: true,
      description: `UTC ${step} identifying one result row within a single function invocation.`,
    },
    {
      member_id: "time",
      kind: "time_dimension",
      column: "time",
      data_type: "TIMESTAMP WITH TIME ZONE",
      timezone: "UTC",
      granularities,
      week_start: "monday",
      description: `UTC timestamp of the Open-Meteo ${step} represented by this row.`,
    },
    {
      member_id: "row_count",
      kind: "measure",
      aggregation: "count_rows",
      additivity: "additive",
      unit: "1",
      description: `Number of ${config.block} Open-Meteo result rows.`,
    },
  ];

  members.push({
    template_id: "invocation_context",
    template: { kind: "dimension" },
    members: sourceArgumentMembers(config),
  });

  const dimensions = config.variables.map((variable) => ({
    member_id: variable.name,
    column: variable.name,
    data_type: dataType(variable),
    ...physicalUnit(variable, Boolean(config.args.units)),
    description: `Open-Meteo ${title(variable.name).toLowerCase()} value for this ${step}.`,
  }));
  members.push({
    template_id: "weather_dimensions",
    template: { kind: "dimension" },
    members: dimensions,
  });

  const measures = config.variables.filter(canAverage).map((variable) => ({
    member_id: `average_${variable.name}`,
    member: variable.name,
    description: `Average ${title(variable.name).toLowerCase()} across the selected result rows.`,
  }));
  if (measures.length) {
    members.push({
      template_id: "average_measures",
      template: {
        kind: "measure",
        aggregation: "avg",
        additivity: "non_additive",
      },
      members: measures,
    });
  }
  return members;
}

export function weatherSemanticTags(
  config: EndpointConfig,
): Record<string, string> {
  const step =
    config.block === "daily"
      ? "day"
      : config.block === "hourly"
        ? "hour"
        : "instant";
  return {
    "vgi.semantic_entity": json({
      entity_id: config.name,
      title: title(config.name),
      description: `${config.description} One row represents one ${step} within a single coordinate invocation.`,
      grain: ["time_key"],
      default_time_dimension: "time",
      source: { arguments: sourceArguments(config) },
    }),
    "vgi.semantic_members": json(weatherMembers(config)),
  };
}

export const GEOCODING_SEMANTIC_TAGS: Record<string, string> = {
  "vgi.semantic_entity": json({
    entity_id: "geocoding",
    title: "Geocoding Results",
    description:
      "Open-Meteo place-search results at one row per stable GeoNames location identifier.",
    grain: ["location_id"],
    source: {
      arguments: [
        { argument: "name", parameter: "name" },
        { argument: "count", parameter: "count", required: false },
        { argument: "language", parameter: "language", required: false },
        {
          argument: "country_code",
          parameter: "country_code",
          required: false,
        },
      ],
    },
  }),
  "vgi.semantic_members": json([
    {
      template_id: "geocoding_invocation_context",
      template: { kind: "dimension" },
      members: [
        {
          member_id: "query_name",
          source_argument: "name",
          data_type: "VARCHAR",
          description: "Place-search text supplied to this invocation.",
        },
        {
          member_id: "requested_count",
          source_argument: "count",
          data_type: "BIGINT",
          unit: "1",
          description:
            "Maximum result count supplied to this invocation, or its function default.",
        },
        {
          member_id: "requested_language",
          source_argument: "language",
          data_type: "VARCHAR",
          description:
            "Result language supplied to this invocation, or its function default.",
        },
        {
          member_id: "requested_country_code",
          source_argument: "country_code",
          data_type: "VARCHAR",
          description:
            "Optional country-code restriction supplied to this invocation.",
        },
      ],
    },
    {
      member_id: "location_id",
      kind: "identifier",
      column: "id",
      data_type: "BIGINT",
      description: "Stable GeoNames identifier for the matched location.",
    },
    {
      member_id: "name",
      kind: "dimension",
      column: "name",
      data_type: "VARCHAR",
      description: "Matched location name in the requested language.",
    },
    {
      member_id: "latitude",
      kind: "dimension",
      column: "latitude",
      data_type: "DOUBLE",
      unit: "deg",
      description: "Matched WGS84 latitude in degrees north.",
    },
    {
      member_id: "longitude",
      kind: "dimension",
      column: "longitude",
      data_type: "DOUBLE",
      unit: "deg",
      description: "Matched WGS84 longitude in degrees east.",
    },
    {
      member_id: "elevation",
      kind: "dimension",
      column: "elevation",
      data_type: "DOUBLE",
      unit: "m",
      description:
        "Matched location elevation in metres above sea level, when known.",
    },
    {
      member_id: "feature_code",
      kind: "dimension",
      column: "feature_code",
      data_type: "VARCHAR",
      description: "GeoNames feature code classifying the matched place.",
    },
    {
      member_id: "country_code",
      kind: "dimension",
      column: "country_code",
      data_type: "VARCHAR",
      description: "ISO 3166-1 alpha-2 country code of the matched place.",
    },
    {
      member_id: "country",
      kind: "dimension",
      column: "country",
      data_type: "VARCHAR",
      description: "Country name of the matched place.",
    },
    {
      member_id: "admin1",
      kind: "dimension",
      column: "admin1",
      data_type: "VARCHAR",
      description: "First-level administrative division of the matched place.",
    },
    {
      member_id: "admin2",
      kind: "dimension",
      column: "admin2",
      data_type: "VARCHAR",
      description: "Second-level administrative division of the matched place.",
    },
    {
      member_id: "admin3",
      kind: "dimension",
      column: "admin3",
      data_type: "VARCHAR",
      description: "Third-level administrative division of the matched place.",
    },
    {
      member_id: "admin4",
      kind: "dimension",
      column: "admin4",
      data_type: "VARCHAR",
      description: "Fourth-level administrative division of the matched place.",
    },
    {
      member_id: "timezone",
      kind: "dimension",
      column: "timezone",
      data_type: "VARCHAR",
      description: "IANA timezone of the matched location.",
    },
    {
      member_id: "population",
      kind: "dimension",
      column: "population",
      data_type: "BIGINT",
      unit: "1",
      description: "Population of the matched location, when known.",
    },
    {
      member_id: "postcodes",
      kind: "dimension",
      column: "postcodes",
      data_type: "VARCHAR[]",
      description: "Postal codes associated with the matched location.",
    },
    {
      member_id: "result_count",
      kind: "measure",
      aggregation: "count_rows",
      additivity: "additive",
      unit: "1",
      description: "Number of matched geocoding results.",
    },
  ]),
};

export const ELEVATION_SEMANTIC_TAGS: Record<string, string> = {
  "vgi.semantic_entity": json({
    entity_id: "elevation",
    title: "Terrain Elevation",
    description:
      "Terrain-height samples at one row per requested WGS84 coordinate pair.",
    grain: ["latitude", "longitude"],
    source: {
      arguments: [
        { argument: "latitude", parameter: "latitude" },
        { argument: "longitude", parameter: "longitude" },
      ],
    },
  }),
  "vgi.semantic_members": json([
    {
      member_id: "latitude",
      kind: "identifier",
      column: "latitude",
      data_type: "DOUBLE",
      description: "Requested WGS84 latitude in degrees north.",
    },
    {
      member_id: "longitude",
      kind: "identifier",
      column: "longitude",
      data_type: "DOUBLE",
      description: "Requested WGS84 longitude in degrees east.",
    },
    {
      member_id: "elevation",
      kind: "dimension",
      column: "elevation",
      data_type: "DOUBLE",
      unit: "m",
      description:
        "Terrain elevation in metres above sea level from the 90 m DEM.",
    },
    {
      member_id: "average_elevation",
      kind: "measure",
      aggregation: "avg",
      member: "elevation",
      additivity: "non_additive",
      description:
        "Average terrain elevation across the selected coordinate rows, in metres.",
    },
    {
      member_id: "point_count",
      kind: "measure",
      aggregation: "count_rows",
      additivity: "additive",
      unit: "1",
      description: "Number of coordinate rows with elevation results.",
    },
  ]),
};

export const WEATHER_CODES_SEMANTIC_TAGS: Record<string, string> = {
  "vgi.semantic_entity": json({
    entity_id: "weather_codes",
    title: "WMO Weather Codes",
    description:
      "WMO 4677 weather-code reference at one row per numeric weather code.",
    grain: ["weather_code"],
  }),
  "vgi.semantic_members": json([
    {
      member_id: "weather_code",
      kind: "identifier",
      column: "code",
      data_type: "INTEGER",
      description: "Unique WMO 4677 weather-interpretation code.",
    },
    {
      member_id: "description",
      kind: "dimension",
      column: "description",
      data_type: "VARCHAR",
      description: "Human-readable English weather condition for the WMO code.",
    },
    {
      member_id: "emoji",
      kind: "dimension",
      column: "emoji",
      data_type: "VARCHAR",
      description: "Representative weather emoji for the WMO code.",
    },
  ]),
};
