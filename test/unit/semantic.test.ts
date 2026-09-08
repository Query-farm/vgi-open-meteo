import { describe, expect, test } from "bun:test";

import { ENDPOINTS } from "../../src/endpoints.js";
import {
  GEOCODING_SEMANTIC_TAGS,
  weatherSemanticTags,
} from "../../src/semantic.js";

type Member = Record<string, any>;

function packed(tags: Record<string, string>): Member[] {
  return JSON.parse(tags["vgi.semantic_members"]);
}

function expanded(tags: Record<string, string>): Member[] {
  return packed(tags).flatMap((item) =>
    item.template_id
      ? item.members.map((member: Member) => ({ ...item.template, ...member }))
      : [item],
  );
}

function weather(name: string): Record<string, string> {
  return weatherSemanticTags(
    ENDPOINTS.find((endpoint) => endpoint.name === name)!,
  );
}

describe("Open-Meteo semantic metadata", () => {
  test("exposes function arguments as selectable invocation context", () => {
    const byId = new Map(
      expanded(weather("forecast_hourly")).map((member) => [
        member.member_id,
        member,
      ]),
    );
    expect(byId.get("requested_latitude")).toMatchObject({
      kind: "dimension",
      conformance_id:
        "farm.query.open_meteo.invocation.requested_latitude",
      source_argument: "latitude",
      data_type: "DOUBLE",
      unit: "deg",
    });
    expect(byId.get("requested_forecast_days")).toMatchObject({
      source_argument: "forecast_days",
      unit: "d",
    });
    expect(byId.get("requested_models")?.source_argument).toBe("models");
    expect(byId.get("time")?.conformance_id).toBe(
      "farm.query.open_meteo.weather.valid_time",
    );
    expect(byId.get("weather_code")?.conformance_id).toBe(
      "farm.query.open_meteo.wmo.weather_code",
    );
  });

  test("publishes reusable filtered weather measures", () => {
    const byId = new Map(
      expanded(weather("forecast_hourly")).map((member) => [
        member.member_id,
        member,
      ]),
    );
    expect(byId.get("daylight_period_count")).toMatchObject({
      aggregation: "count_rows",
      filter: { member: "is_day", operator: "eq", value: true },
      additivity: "additive",
      unit: "1",
    });
    expect(byId.get("wet_period_count")).toMatchObject({
      aggregation: "count_rows",
      filter: { member: "precipitation", operator: "gt", value: 0 },
      additivity: "additive",
      unit: "1",
    });
  });

  test("declares default and requested physical units through function arguments", () => {
    const byId = new Map(
      expanded(weather("forecast_hourly")).map((member) => [
        member.member_id,
        member,
      ]),
    );
    expect(byId.get("temperature_2m")?.unit_parameter).toEqual({
      argument: "temperature_unit",
      values: { celsius: "Cel", fahrenheit: "[degF]" },
    });
    expect(byId.get("wind_speed_10m")?.unit_parameter.values).toEqual({
      kmh: "km/h",
      ms: "m/s",
      mph: "[mi_i]/h",
      kn: "[kn_i]",
    });
    expect(byId.get("precipitation")?.unit_parameter.values).toEqual({
      mm: "mm",
      inch: "[in_i]",
    });
    expect(byId.get("snowfall")?.unit_parameter.values.mm).toBe("cm");
    expect(byId.get("relative_humidity_2m")?.unit).toBe("%");
    expect(byId.get("pressure_msl")?.unit).toBe("hPa");
    expect(byId.get("row_count")?.unit).toBe("1");
  });

  test("uses static units where the worker does not expose unit controls", () => {
    const air = new Map(
      expanded(weather("air_quality_hourly")).map((member) => [
        member.member_id,
        member,
      ]),
    );
    expect(air.get("pm2_5")?.unit).toBe("ug/m3");
    expect(air.get("us_aqi")?.unit).toBe("1");

    const marine = new Map(
      expanded(weather("marine_hourly")).map((member) => [
        member.member_id,
        member,
      ]),
    );
    expect(marine.get("wave_height")?.unit).toBe("m");
    expect(marine.get("wave_period")?.unit).toBe("s");

    const flood = new Map(
      expanded(weather("flood_daily")).map((member) => [
        member.member_id,
        member,
      ]),
    );
    expect(flood.get("river_discharge")?.unit).toBe("m3/s");
  });

  test("packs repeated dimensions and measures as member templates", () => {
    const entries = packed(weather("ensemble_hourly"));
    expect(
      entries.find((entry) => entry.template_id === "weather_dimensions"),
    ).toMatchObject({
      template: { kind: "dimension" },
      members: expect.arrayContaining([
        expect.objectContaining({ member_id: "temperature_2m_member30" }),
      ]),
    });
    expect(
      entries.find((entry) => entry.template_id === "average_measures"),
    ).toMatchObject({
      template: {
        kind: "measure",
        aggregation: "avg",
        additivity: "non_additive",
      },
    });
  });

  test("makes geocoding search arguments selectable without colliding with output columns", () => {
    const byId = new Map(
      expanded(GEOCODING_SEMANTIC_TAGS).map((member) => [
        member.member_id,
        member,
      ]),
    );
    expect(byId.get("query_name")?.source_argument).toBe("name");
    expect(byId.get("requested_country_code")?.source_argument).toBe(
      "country_code",
    );
    expect(byId.get("country_code")?.column).toBe("country_code");
  });
});
