// Arrow schemas for the Open-Meteo tables.
//
// The block functions (forecast/historical/air-quality/marine/flood/climate)
// share one schema builder: a `time` column plus one column per curated
// variable, typed from the variable's `kind`. Geocoding and elevation have
// bespoke static schemas.

import {
  Schema,
  Field,
  Bool,
  Float64,
  Int32,
  Int64,
  List,
  Timestamp,
  TimeUnit,
  Utf8,
  type DataType,
} from "@query-farm/apache-arrow";

import type { EndpointConfig, WeatherVar } from "./endpoints.js";

const tsUtcMicros = () => new Timestamp(TimeUnit.MICROSECOND, "UTC");

/**
 * Build a `Field` carrying a column comment in its metadata. DuckDB surfaces
 * the `comment` key via `duckdb_columns()` / `DESCRIBE`.
 */
export function field(
  name: string,
  type: DataType,
  comment: string,
  nullable = true,
): Field {
  return new Field(name, type, nullable, new Map([["comment", comment]]));
}

/** A DuckDB-facing SQL type label for an Arrow type (for `vgi.result_columns_md`). */
function sqlTypeName(type: DataType): string {
  if (type instanceof Float64) return "DOUBLE";
  if (type instanceof Int32) return "INTEGER";
  if (type instanceof Int64) return "BIGINT";
  if (type instanceof Bool) return "BOOLEAN";
  if (type instanceof Utf8) return "VARCHAR";
  if (type instanceof Timestamp) return "TIMESTAMP WITH TIME ZONE";
  if (type instanceof List) return "VARCHAR[]";
  return "VARCHAR";
}

/**
 * Render a schema as a Markdown column table for the `vgi.result_columns_md`
 * tag. Table functions have a dynamic schema DuckDB can't expose up front, so
 * this documents the returned columns (name, type, meaning) for agents/humans.
 */
export function resultColumnsMd(schema: Schema): string {
  const rows = schema.fields.map(
    (f) => `| \`${f.name}\` | ${sqlTypeName(f.type)} | ${f.metadata.get("comment") ?? ""} |`,
  );
  return ["| Column | Type | Description |", "| --- | --- | --- |", ...rows].join("\n");
}

/** Arrow type for a weather variable's kind. */
function arrowType(v: WeatherVar): DataType {
  switch (v.kind) {
    case "double":
      return new Float64();
    case "int":
      return new Int32();
    case "bool":
      return new Bool();
    case "timestamp":
      return tsUtcMicros();
  }
}

/**
 * Schema for a block function: a UTC `time` column followed by one column per
 * variable. `current` blocks emit a single row; hourly/daily one row per step.
 */
export function blockSchema(config: EndpointConfig): Schema {
  const timeComment =
    config.block === "current"
      ? "Timestamp of the current conditions (UTC)."
      : config.block === "daily"
        ? "Start of the day this row aggregates (UTC)."
        : "Timestamp of this hourly step (UTC).";

  const fields: Field[] = [field("time", tsUtcMicros(), timeComment, false)];
  for (const v of config.variables) {
    fields.push(field(v.name, arrowType(v), `Open-Meteo "${v.name}" value; units per request options.`));
  }
  return new Schema(fields);
}

// ---------------------------------------------------------------------------
// Geocoding (search) — bridge from place names to coordinates.
// ---------------------------------------------------------------------------

export const GEOCODING_SCHEMA = new Schema([
  field("id", new Int64(), "GeoNames location id (stable join key)."),
  field("name", new Utf8(), "Location name in the requested language."),
  field("latitude", new Float64(), "Latitude in decimal degrees (WGS84)."),
  field("longitude", new Float64(), "Longitude in decimal degrees (WGS84)."),
  field("elevation", new Float64(), "Elevation in metres above sea level."),
  field("feature_code", new Utf8(), "GeoNames feature code (e.g. PPLC = capital city)."),
  field("country_code", new Utf8(), "ISO-3166-1 alpha2 country code."),
  field("country", new Utf8(), "Country name."),
  field("admin1", new Utf8(), "First-level administrative division (e.g. state)."),
  field("admin2", new Utf8(), "Second-level administrative division."),
  field("admin3", new Utf8(), "Third-level administrative division."),
  field("admin4", new Utf8(), "Fourth-level administrative division."),
  field("timezone", new Utf8(), "IANA timezone of the location."),
  field("population", new Int64(), "Population, if known."),
  field("postcodes", new List(new Field("item", new Utf8(), true)), "Associated postal codes; null if none."),
]);

// ---------------------------------------------------------------------------
// Elevation — terrain elevation for a coordinate.
// ---------------------------------------------------------------------------

export const ELEVATION_SCHEMA = new Schema([
  field("latitude", new Float64(), "Requested latitude (WGS84).", false),
  field("longitude", new Float64(), "Requested longitude (WGS84).", false),
  field("elevation", new Float64(), "Terrain elevation in metres (90m DEM)."),
]);
