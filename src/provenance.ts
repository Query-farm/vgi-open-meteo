import type { EndpointConfig } from "./endpoints.js";
import type { OmResponse } from "./open-meteo.js";

// Explicit shared definitions for physical columns and semantic dimensions.
// These describe response provenance, not inferred model-run provenance.
export const PROVENANCE_FIELDS = [
  { name: "model_selection", title: "Requested model selection", type: "VARCHAR", description: "Requested model, or provider_default where not selectable. best_match may blend models; even an explicit model may not source every derived field (e.g. precipitation probability)." },
  { name: "source_endpoint", title: "Source API product", type: "VARCHAR", description: "API product URL, without query or credentials (customer host for commercial requests)." },
  { name: "retrieved_at", title: "Response retrieved at (UTC)", type: "TIMESTAMP WITH TIME ZONE", description: "When the worker received the upstream response (kept on cache hits). Not a model run time, issue time or freshness guarantee." },
  { name: "grid_latitude", title: "Returned grid latitude", type: "DOUBLE", unit: "deg", description: "Provider's grid latitude; may differ from the requested point and not identify every grid in blended data." },
  { name: "grid_longitude", title: "Returned grid longitude", type: "DOUBLE", unit: "deg", description: "Provider's grid longitude; may differ from the requested point." },
  { name: "location_elevation", title: "Downscaling elevation", type: "DOUBLE", unit: "m", description: "Provider's target elevation for grid selection and downscaling, if supplied; not necessarily the model-grid elevation." },
  { name: "response_timezone", title: "Resolved response timezone", type: "VARCHAR", description: "Provider-resolved timezone. Timestamps stay UTC; the UTC offset labels provider daily intervals." },
  { name: "utc_offset_seconds", title: "Response UTC offset", type: "INTEGER", unit: "s", description: "Provider's fixed UTC offset for the response; not adjusted for DST changes within it." },
] as const;

export const INTERVAL_FIELDS = [
  { name: "interval_start", title: "Aggregation interval start (UTC)", type: "TIMESTAMP WITH TIME ZONE", description: "Start of the nominal aggregation window, for fields assigned it in open_meteo.temporal; instantaneous values use time." },
  { name: "interval_end", title: "Aggregation interval end (UTC)", type: "TIMESTAMP WITH TIME ZONE", description: "End of the nominal aggregation window (hourly/current windows end at time; daily start at time). Source-dependent fields have no common window." },
  { name: "interval_seconds", title: "Aggregation interval length", type: "INTEGER", unit: "s", description: "Window length: 3600 hourly, 86400 per provider day, or the provider's current.interval (NULL if unknown). Not the native model resolution." },
] as const;

export function hasProvenance(name: string): boolean {
  return ["forecast_current", "forecast_hourly", "forecast_daily", "historical_hourly", "historical_daily", "air_quality_current", "air_quality_hourly"].includes(name);
}

export function contextFields(name: string) {
  if (!hasProvenance(name)) return [];
  return name.startsWith("air_quality") ? [...PROVENANCE_FIELDS] : [...PROVENANCE_FIELDS, ...INTERVAL_FIELDS];
}

export function modelSelection(value: unknown): string {
  const model = value === undefined || value === null ? "best_match" : value;
  if (typeof model !== "string" || !/^[A-Za-z0-9_]+$/.test(model)) {
    throw new Error("model must be one non-empty Open-Meteo model identifier, such as best_match, gfs_global or era5. Compare models in separate queries; comma-separated lists change the output schema.");
  }
  return model;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function int32(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : null;
}

export function responseContext(config: EndpointConfig, response: OmResponse, selectedModel: string, times: (bigint | null)[]): Record<string, any[]> {
  if (!hasProvenance(config.name)) return {};
  const data = response.data;
  const offset = int32(data?.utc_offset_seconds);
  const values: Record<string, unknown> = {
    model_selection: selectedModel,
    source_endpoint: `https://${config.host}${config.path}`,
    retrieved_at: BigInt(response.retrievedAt) * 1000n,
    grid_latitude: finite(data?.latitude),
    grid_longitude: finite(data?.longitude),
    location_elevation: finite(data?.elevation),
    response_timezone: typeof data?.timezone === "string" ? data.timezone : null,
    utc_offset_seconds: offset,
  };
  const result: Record<string, any[]> = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, times.map(() => value)]));
  if (config.name.startsWith("air_quality")) return result;
  const currentInterval = int32(data?.current?.interval);
  const seconds = config.block === "daily" ? 86400 : config.block === "hourly" ? 3600
    : currentInterval !== null && currentInterval > 0 ? currentInterval : null;
  const duration = seconds === null ? null : BigInt(seconds) * 1_000_000n;
  result.interval_seconds = times.map(() => seconds);
  result.interval_start = times.map(time => time === null || duration === null ? null : config.block === "daily" ? time : time - duration);
  result.interval_end = times.map(time => time === null || duration === null ? null : config.block === "daily" ? time + duration : time);
  return result;
}

export const PROVENANCE_TAG = JSON.stringify({
  version: 1,
  model_selection_member: "model_selection",
  retrieval_time_member: "retrieved_at",
  model_run_time: "not_supplied",
  forecast_issue_time: "not_supplied",
  forecast_lead_time: "not_derivable",
  resolved_model_per_variable: "not_supplied",
  note: "Regular API responses do not identify a unique run. Model-update status timestamps must not be treated as the run behind these rows. Explicit model selection can still include derived fields from auxiliary sources.",
});
