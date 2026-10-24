import { describe, expect, test } from "bun:test";
import { ENDPOINTS } from "../../src/endpoints.js";
import { blockSchema, resultColumnsSchema, GEOCODING_SCHEMA, ELEVATION_SCHEMA } from "../../src/schemas.js";
import { weatherSemanticTags, GEOCODING_SEMANTIC_TAGS, ELEVATION_SEMANTIC_TAGS, WEATHER_CODES_SEMANTIC_TAGS } from "../../src/semantic.js";
import { parseBlock } from "../../src/weather.js";

type Member = Record<string, any>;
function members(name: string): Member[] {
  return JSON.parse(weatherSemanticTags(name)["vgi.semantic_members"]);
}

describe("curated weather model", () => {
  test("specialist and new endpoints do not automatically become semantic entities", () => {
    for (const name of ["ensemble_hourly", "ensemble_daily", "previous_runs_hourly", "climate_daily", "marine_hourly", "marine_daily", "flood_daily", "future_endpoint"]) {
      expect(weatherSemanticTags(name)).toEqual({});
    }
  });

  test("every returned field is selectable with its original name, type and a readable title", () => {
    const sources = [
      ...ENDPOINTS.filter(e => weatherSemanticTags(e.name)["vgi.semantic_entity"])
        .map(e => ({ tags: weatherSemanticTags(e.name), schema: blockSchema(e) })),
      { tags: GEOCODING_SEMANTIC_TAGS, schema: GEOCODING_SCHEMA },
      { tags: ELEVATION_SEMANTIC_TAGS, schema: ELEVATION_SCHEMA },
    ];
    for (const { tags, schema } of sources) {
      const fields = new Map(JSON.parse(resultColumnsSchema(schema)).map((f: any) => [f.name, f.type]));
      const selected: Member[] = JSON.parse(tags["vgi.semantic_members"]);
      const byId = new Map(selected.map(m => [m.member_id, m]));
      expect(byId.size).toBe(selected.length);
      const visible = selected.filter(m => m.column && !m.hidden);
      expect(visible.map(m => m.column).sort()).toEqual([...fields.keys()].sort());
      for (const m of visible) expect(m.member_id).toBe(m.column);
      const checkFilter = (filter: any): void => {
        if (filter.and) filter.and.forEach(checkFilter);
        else expect(byId.get(filter.member)?.kind).toBe("dimension");
      };
      for (const m of selected) {
        expect(m.title.length).toBeGreaterThan(0);
        expect(m.description.length).toBeGreaterThan(0);
        if (m.column) expect(fields.get(m.column)).toBe(m.data_type);
        if (m.member) expect(byId.get(m.member)?.kind).toBe("dimension");
        if (m.filter) checkFilter(m.filter);
        expect(m.template_id).toBeUndefined();
      }
    }
    expect(JSON.parse(WEATHER_CODES_SEMANTIC_TAGS["vgi.semantic_members"]).map((m: Member) => m.member_id))
      .toEqual(["code", "description", "emoji"]);
  });

  test("period summaries use sums and extremes, with duration independent of precipitation units", () => {
    for (const name of ["forecast_daily", "historical_daily"]) {
      const byId = new Map(members(name).map(m => [m.member_id, m]));
      expect(byId.get("total_precipitation")).toMatchObject({ aggregation: "sum", member: "precipitation_sum" });
      expect(byId.get("highest_temperature")).toMatchObject({ aggregation: "max", member: "temperature_2m_max" });
      expect(byId.get("lowest_temperature")).toMatchObject({ aggregation: "min", member: "temperature_2m_min" });
      expect(byId.get("precipitation_hours")?.unit).toBe("h");
      expect(byId.get("precipitation_hours")?.unit_parameter).toBeUndefined();
      expect(byId.get("date")).toMatchObject({ kind: "dimension", data_type: "DATE" });
      // A local daily interval must not silently acquire UTC calendar rollups.
      expect(JSON.parse(weatherSemanticTags(name)["vgi.semantic_entity"]).default_time_dimension).toBeUndefined();
    }
  });

  test("snow depth, water equivalent, irradiance and energy keep distinct units", () => {
    const hourly = new Map(members("historical_hourly").map(m => [m.member_id, m]));
    const daily = new Map(members("historical_daily").map(m => [m.member_id, m]));
    expect(hourly.get("snowfall")?.unit_parameter.values).toEqual({ mm: "cm", inch: "[in_i]" });
    expect(daily.get("snowfall_sum")?.unit_parameter.values).toEqual({ mm: "cm", inch: "[in_i]" });
    expect(hourly.get("precipitation")?.unit_parameter.values).toEqual({ mm: "mm", inch: "[in_i]" });
    expect(hourly.get("shortwave_radiation")?.unit).toBe("W/m2");
    expect(daily.get("shortwave_radiation_sum")?.unit).toBe("MJ/m2");
  });

  test("categorical values, directions and solar times are never arithmetic measures", () => {
    for (const endpoint of ENDPOINTS) {
      if (!weatherSemanticTags(endpoint.name)["vgi.semantic_members"]) continue;
      for (const m of members(endpoint.name).filter(m => m.kind === "measure")) {
        expect(["weather_code", "is_day", "wind_direction_10m", "wind_direction_10m_dominant", "sunrise", "sunset"])
          .not.toContain(m.member);
      }
    }
  });
});

describe("daily calendar dates", () => {
  const variables = [{ name: "temperature_2m_max", kind: "double" as const }];
  test.each([
    ["Tokyo", "2023-12-31T15:00:00Z", 32400],
    ["New York", "2024-01-01T05:00:00Z", -18000],
    ["Kathmandu", "2023-12-31T18:15:00Z", 20700],
    ["UTC", "2024-01-01T00:00:00Z", 0],
  ])("labels %s's day without changing the UTC instant", (_, instant, offset) => {
    const seconds = Date.parse(instant as string) / 1000;
    const result = parseBlock({ time: [seconds], temperature_2m_max: [20] }, variables, false, offset as number);
    expect(result.date).toEqual([19723]); // 2024-01-01 in Arrow date32 days
    expect(result.time).toEqual([BigInt(seconds) * 1_000_000n]);
  });
  test("unknown offsets and missing times produce unknown dates, not a guessed UTC day", () => {
    const result = parseBlock({ time: [1704067200, null] }, variables, false, NaN);
    expect(result.date).toEqual([null, null]);
    expect(parseBlock(undefined, variables, false, 0).date).toEqual([]);
  });
  test("hourly data does not acquire a daily date", () => {
    expect(parseBlock({ time: [1704067200] }, variables, false).date).toBeUndefined();
  });
});
