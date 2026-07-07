// Arrow schemas for the Open-Meteo tables.
//
// The block functions (forecast/historical/air-quality/marine/flood/climate)
// share one schema builder: a `time` column plus one column per curated
// variable, typed from the variable's `kind`. Geocoding and elevation have
// bespoke static schemas.
//
// All Arrow types are built through vgi's backend-agnostic factories (arrow-js
// on Bun/Node, flechette under workerd/Cloudflare) — never `@query-farm/apache-arrow`
// directly — so the same source compiles for the stdio/HTTP worker and the CF
// Worker. `int32`/`bool` collide with vgi-rpc arg builders at the package root,
// so they come from the `vgi/worker-cf` arrow facade.

// Import every Arrow factory/predicate from the `vgi/worker-cf` facade (not the
// package root): the root re-exports the Node-only stdio `Worker`, which drags
// in `serveUnix`/`serveTcp` that don't exist in vgi-rpc's workerd build and
// break the Cloudflare bundle. worker-cf is the workerd-safe surface and works
// identically on Bun.
import {
  bool,
  field as makeField,
  float64,
  int32,
  int64,
  isBool,
  isFloat,
  isInt,
  isList,
  isTimestamp,
  isUtf8,
  list,
  schema,
  TimeUnit,
  timestamp,
  utf8,
  type VgiDataType,
  type VgiField,
  type VgiSchema,
} from "vgi/worker-cf";

import type { EndpointConfig, WeatherVar } from "./endpoints.js";

const tsUtcMicros = (): VgiDataType => timestamp(TimeUnit.MICROSECOND, "UTC");

/**
 * Build a `Field` carrying a column comment in its metadata. DuckDB surfaces
 * the `comment` key via `duckdb_columns()` / `DESCRIBE`.
 */
export function field(
  name: string,
  type: VgiDataType,
  comment: string,
  nullable = true,
): VgiField {
  return makeField(name, type, nullable, new Map([["comment", comment]]));
}

/** A DuckDB-facing SQL type label for an Arrow type (for `vgi.result_columns_md`). */
function sqlTypeName(type: VgiDataType): string {
  if (isFloat(type)) return "DOUBLE";
  if (isInt(type)) return (type as { bitWidth?: number }).bitWidth === 64 ? "BIGINT" : "INTEGER";
  if (isBool(type)) return "BOOLEAN";
  if (isUtf8(type)) return "VARCHAR";
  if (isTimestamp(type)) return "TIMESTAMP WITH TIME ZONE";
  if (isList(type)) return "VARCHAR[]";
  return "VARCHAR";
}

/**
 * Render a schema as a Markdown column table for the `vgi.result_columns_md`
 * tag. Table functions have a dynamic schema DuckDB can't expose up front, so
 * this documents the returned columns (name, type, meaning) for agents/humans.
 */
export function resultColumnsMd(sch: VgiSchema): string {
  const rows = sch.fields.map(
    (f) => `| \`${f.name}\` | ${sqlTypeName(f.type)} | ${f.metadata.get("comment") ?? ""} |`,
  );
  return ["| Column | Type | Description |", "| --- | --- | --- |", ...rows].join("\n");
}

/** Arrow type for a weather variable's kind. */
function arrowType(v: WeatherVar): VgiDataType {
  switch (v.kind) {
    case "double":
      return float64();
    case "int":
      return int32();
    case "bool":
      return bool();
    case "timestamp":
      return timestamp(TimeUnit.MICROSECOND, "UTC");
  }
}

/**
 * Schema for a block function: a UTC `time` column followed by one column per
 * variable. `current` blocks emit a single row; hourly/daily one row per step.
 */
export function blockSchema(config: EndpointConfig): VgiSchema {
  const timeComment =
    config.block === "current"
      ? "Timestamp of the current conditions (UTC)."
      : config.block === "daily"
        ? "Start of the day this row aggregates (UTC)."
        : "Timestamp of this hourly step (UTC).";

  const fields: VgiField[] = [field("time", tsUtcMicros(), timeComment, false)];
  for (const v of config.variables) {
    fields.push(field(v.name, arrowType(v), `Open-Meteo "${v.name}" value; units per request options.`));
  }
  return schema(fields);
}

// ---------------------------------------------------------------------------
// Geocoding (search) — bridge from place names to coordinates.
// ---------------------------------------------------------------------------

export const GEOCODING_SCHEMA: VgiSchema = schema([
  field("id", int64(), "GeoNames location id (stable join key)."),
  field("name", utf8(), "Location name in the requested language."),
  field("latitude", float64(), "Latitude in decimal degrees (WGS84)."),
  field("longitude", float64(), "Longitude in decimal degrees (WGS84)."),
  field("elevation", float64(), "Elevation in metres above sea level."),
  field("feature_code", utf8(), "GeoNames feature code (e.g. PPLC = capital city)."),
  field("country_code", utf8(), "ISO-3166-1 alpha2 country code."),
  field("country", utf8(), "Country name."),
  field("admin1", utf8(), "First-level administrative division (e.g. state)."),
  field("admin2", utf8(), "Second-level administrative division."),
  field("admin3", utf8(), "Third-level administrative division."),
  field("admin4", utf8(), "Fourth-level administrative division."),
  field("timezone", utf8(), "IANA timezone of the location."),
  field("population", int64(), "Population, if known."),
  field("postcodes", list(makeField("item", utf8(), true)), "Associated postal codes; null if none."),
]);

// ---------------------------------------------------------------------------
// Elevation — terrain elevation for a coordinate.
// ---------------------------------------------------------------------------

export const ELEVATION_SCHEMA: VgiSchema = schema([
  field("latitude", float64(), "Requested latitude (WGS84).", false),
  field("longitude", float64(), "Requested longitude (WGS84).", false),
  field("elevation", float64(), "Terrain elevation in metres (90m DEM)."),
]);
