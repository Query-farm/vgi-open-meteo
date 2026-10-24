import { expect, test } from "bun:test";
import { ENDPOINTS } from "../../src/endpoints.js";
import { _resetCaches, omGet, omGetWithMetadata } from "../../src/open-meteo.js";
import { modelSelection, responseContext } from "../../src/provenance.js";
import { temporalTags } from "../../src/temporal.js";

const endpoint = (name: string) => ENDPOINTS.find(e => e.name === name)!;
const time = 1704067200n * 1_000_000n;

test("retrieval time is stamped on response completion and preserved on cache hits", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1000;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = (async () => {
    calls++;
    now += 500;
    return Response.json({ temperature: calls });
  }) as typeof fetch;
  _resetCaches();
  try {
    const first = await omGetWithMetadata("api.open-meteo.com", "/v1/forecast", { models: "best_match" });
    expect(first.retrievedAt).toBe(1500);
    now = 2000;
    const cached = await omGetWithMetadata("api.open-meteo.com", "/v1/forecast", { models: "best_match" });
    expect(cached).toBe(first);
    expect(await omGet("api.open-meteo.com", "/v1/forecast", { models: "best_match" })).toEqual({ temperature: 1 });
    const differentModel = await omGetWithMetadata("api.open-meteo.com", "/v1/forecast", { models: "gfs_global" });
    expect(differentModel.data.temperature).toBe(2);
    const refreshed = await omGetWithMetadata("api.open-meteo.com", "/v1/forecast", { models: "best_match" }, { ttlMs: 0 });
    expect(refreshed.retrievedAt).toBe(3000);
    expect(calls).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    _resetCaches();
  }
});

test("model selection rejects lists and empty identifiers", () => {
  expect(modelSelection(undefined)).toBe("best_match");
  expect(modelSelection("era5")).toBe("era5");
  for (const value of ["", "era5,era5_land", "gfs_global ", " ", 1]) {
    expect(() => modelSelection(value)).toThrow("one non-empty");
  }
});

test("provenance preserves provider metadata and never substitutes requested coordinates", () => {
  const context = responseContext(endpoint("forecast_hourly"), {
    data: { latitude: 0, longitude: 0, elevation: 0, timezone: "GMT", utc_offset_seconds: 0 }, retrievedAt: 1234,
  }, "gfs_global", [time]);
  expect(context.grid_latitude).toEqual([0]);
  expect(context.location_elevation).toEqual([0]);
  expect(context.utc_offset_seconds).toEqual([0]);
  expect(context.model_selection).toEqual(["gfs_global"]);
  expect(context.retrieved_at).toEqual([1234000n]);
  expect(context.source_endpoint).toEqual(["https://api.open-meteo.com/v1/forecast"]);
  const missing = responseContext(endpoint("forecast_hourly"), {
    data: { latitude: null, longitude: NaN, elevation: Infinity, utc_offset_seconds: 2147483648 }, retrievedAt: 1234,
  }, "best_match", [time]);
  for (const name of ["grid_latitude", "grid_longitude", "location_elevation", "response_timezone", "utc_offset_seconds"]) {
    expect(missing[name]).toEqual([null]);
  }
  expect(missing.model_run_time).toBeUndefined();
  expect(missing.forecast_lead_time).toBeUndefined();
});

test("hourly windows end at valid time and provider days begin at valid time", () => {
  const response = { data: {}, retrievedAt: 1 };
  const hourly = responseContext(endpoint("forecast_hourly"), response, "best_match", [time]);
  expect(hourly.interval_start).toEqual([time - 3600_000_000n]);
  expect(hourly.interval_end).toEqual([time]);
  const daily = responseContext(endpoint("forecast_daily"), response, "best_match", [time, null]);
  expect(daily.interval_start).toEqual([time, null]);
  expect(daily.interval_end).toEqual([time + 86400_000_000n, null]);
  expect(daily.interval_seconds).toEqual([86400, 86400]);
});

test("current windows use the supplied duration and preserve unknown bounds", () => {
  for (const interval of [900, 1800, undefined, null, 0, -1, NaN, Infinity, 1.5, 2147483648]) {
    const c = responseContext(endpoint("forecast_current"), { data: { current: { interval } }, retrievedAt: 1 }, "best_match", [time]);
    const valid = interval === 900 || interval === 1800;
    expect(c.interval_seconds).toEqual([valid ? interval : null]);
    expect(c.interval_start).toEqual([valid ? time - BigInt(interval!) * 1_000_000n : null]);
    expect(c.interval_end).toEqual([valid ? time : null]);
  }
});

test("all weather variables have explicit structured reporting support", () => {
  for (const e of ENDPOINTS) {
    const serialized = temporalTags(e.name)["open_meteo.temporal"];
    if (!serialized) continue;
    const contract = JSON.parse(serialized);
    expect(contract.version).toBe(1);
    expect(Object.keys(contract.members).sort()).toEqual(e.variables.map(v => v.name).sort());
  }
  const support = (entity: string, field: string) => JSON.parse(temporalTags(entity)["open_meteo.temporal"]).members[field];
  expect(support("forecast_hourly", "dew_point_2m")).toEqual({ support: "instant", time_member: "time" });
  expect(support("forecast_hourly", "precipitation_probability")).toMatchObject({ support: "preceding_interval", statistic: "probability", duration_seconds: 3600, nominal_threshold: { value: 0.1, unit: "mm" } });
  expect(support("historical_hourly", "shortwave_radiation")).toMatchObject({ statistic: "mean", duration_seconds: 3600 });
  expect(support("forecast_daily", "sunrise")).toEqual({ support: "event_time", time_member: "sunrise" });
  expect(support("forecast_current", "precipitation")).toMatchObject({ duration_member: "interval_seconds" });
  for (const [entity, field] of [["historical_hourly", "wind_gusts_10m"], ["forecast_current", "wind_gusts_10m"], ["forecast_hourly", "uv_index"], ["air_quality_hourly", "us_aqi"]]) {
    expect(support(entity, field).support).toBe("source_dependent");
    expect(support(entity, field).start_member).toBeUndefined();
  }
});
