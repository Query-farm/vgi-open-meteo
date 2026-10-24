// Real worker + deterministic upstream responses. No network access is allowed.
// Tests therefore exercise discovery, binding, Arrow dates and row provenance,
// as well as the semantic compiler's SQL and units, without weather API drift.
// A fixed retrieval clock keeps independent worker sessions comparable. The
// client-cache timestamp behavior is exercised separately in unit tests.
Date.now = () => Date.parse("2024-01-08T00:00:00Z");
const fetchFixture = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input);
  const q = url.searchParams;
  if (url.hostname === "geocoding-api.open-meteo.com") {
    const tokyo = q.get("name") === "Tokyo";
    return Response.json({ results: [{ id: tokyo ? 2 : 1, name: tokyo ? "Tokyo" : "Berlin",
      latitude: tokyo ? 35.69 : 52.52, longitude: tokyo ? 139.69 : 13.41,
      admin1: tokyo ? "Tokyo" : "Berlin", country: tokyo ? "Japan" : "Germany",
      country_code: tokyo ? "JP" : "DE", timezone: tokyo ? "Asia/Tokyo" : "Europe/Berlin",
      elevation: 40, feature_code: "PPLC", admin2: "District", admin3: "Locality", admin4: "Ward",
      population: 1000000, postcodes: ["10000"] }] });
  }
  if (!["api.open-meteo.com", "archive-api.open-meteo.com", "air-quality-api.open-meteo.com"].includes(url.hostname)) {
    throw new Error(`Unexpected fixture request: ${url}`);
  }
  const tokyo = Number(q.get("longitude")) > 100;
  if ((q.get("models") ?? "").includes(",")) throw new Error("Fixture refuses unsupported model lists");
  const modelAdjustment = q.get("models") === "gfs_global" ? -2 : q.get("models") === "era5" ? 1 : 0;
  const offset = q.get("timezone") === "auto" ? (tokyo ? 32400 : 3600) : 0;
  const temp = (x: number | null) => x === null ? null : q.get("temperature_unit") === "fahrenheit" ? (x + modelAdjustment) * 1.8 + 32 : x + modelAdjustment;
  const rain = (x: number | null) => x === null ? null : x * (tokyo ? 2 : 1) / (q.get("precipitation_unit") === "inch" ? 25.4 : 1);
  const snow = (x: number) => x / (q.get("precipitation_unit") === "inch" ? 2.54 : 1);
  const noPrecipitationData = Number(q.get("latitude")) === -1;
  const start = Date.parse("2024-01-01T00:00:00Z") / 1000;
  const respond = (body: object) => Response.json({
    ...(Number(q.get("latitude")) === -2 ? {} : {
      latitude: Number((Number(q.get("latitude")) + 0.01).toFixed(4)),
      longitude: Number((Number(q.get("longitude")) - 0.01).toFixed(4)),
      elevation: 40, timezone: q.get("timezone") === "auto" ? (tokyo ? "Asia/Tokyo" : "Europe/Berlin") : "GMT",
      utc_offset_seconds: offset,
    }), ...body,
  });
  if (q.has("daily")) {
    return respond({ daily: {
      time: Array.from({ length: 7 }, (_, i) => start - offset + i * 86400),
      temperature_2m_max: [20, 25, 18, 22, 24, 19, 21].map(temp),
      temperature_2m_min: [10, null, null, 9, 11, 7, 6].map(temp),
      apparent_temperature_max: [18, 23, 16, 20, 22, 17, 19].map(temp),
      apparent_temperature_min: [8, 6, 10, 7, 9, 5, 4].map(temp),
      sunrise: Array.from({ length: 7 }, (_, i) => start - offset + i * 86400 + 21600),
      sunset: Array.from({ length: 7 }, (_, i) => start - offset + i * 86400 + 64800),
      precipitation_sum: noPrecipitationData ? Array(7).fill(null) : [2, 0, 5, null, 1, 0, 4].map(rain),
      rain_sum: [1, 0, 3, null, 1, 0, 4].map(rain),
      snowfall_sum: [1, 0, 2, 0, 0, 0, 0].map(snow),
      precipitation_hours: [1, 0, 3, null, 2, 0, 1],
      wind_speed_10m_max: [10, 20, 15, 12, 14, 11, 13],
      wind_gusts_10m_max: [12, 30, 20, 18, 17, 15, 19],
      wind_direction_10m_dominant: [315, 270, 225, 180, 135, 90, 45],
      shortwave_radiation_sum: [5, 10, 8, 7, 6, 4, 3],
      weather_code: [61, 0, 999, null, 61, 0, 61],
    } });
  }
  const current = { time: start, interval: Number(q.get("latitude")) === -2 ? undefined : Number(q.get("latitude")) === 1 ? 1800 : 900,
    temperature_2m: temp(20), apparent_temperature: temp(18),
    relative_humidity_2m: 60, wind_speed_10m: 10, wind_direction_10m: 315,
    precipitation: rain(0.5), cloud_cover: 75, pressure_msl: 1013, wind_gusts_10m: 15,
    is_day: 1, weather_code: Number(q.get("latitude")) === 0 ? 999 : 61,
    us_aqi: 120, european_aqi: 75, pm2_5: 20, pm10: 30,
    carbon_monoxide: 200, nitrogen_dioxide: 10, sulphur_dioxide: 5, ozone: 60, dust: 4, uv_index: 3 };
  if (q.has("current")) return respond({ current });
  if (q.has("hourly")) return respond({ hourly: {
    time: [start, start + 3600, start + 7200],
    temperature_2m: [10, 20, null].map(temp), precipitation: noPrecipitationData ? [null, null, null] : [2, null, null].map(rain),
    relative_humidity_2m: [60, 50, 70], apparent_temperature: [8, 18, null].map(temp),
    rain: [1, null, null].map(rain), snowfall: [1, 0, 0].map(snow),
    precipitation_probability: [20, 80, null],
    pressure_msl: [1013, 1012, 1011], cloud_cover: [20, 30, 40],
    wind_speed_10m: [10, 20, 15], wind_direction_10m: [315, 270, 225], wind_gusts_10m: [15, 30, 25],
    visibility: [10000, 5000, 8000], weather_code: [0, 61, null], uv_index: [1, 6, 3], is_day: [1, 1, 1],
    dew_point_2m: [3, 9, 4].map(temp), surface_pressure: [1000, 999, 998], shortwave_radiation: [100, 200, 150],
    us_aqi: [30, 120, 50], european_aqi: [20, 75, 40], pm2_5: [10, 30, null], pm10: [20, 40, 30],
    carbon_monoxide: [200, 220, 210], nitrogen_dioxide: [10, 20, 15], sulphur_dioxide: [5, 10, 8],
    ozone: [60, 80, 70], dust: [4, 6, 5],
  } });
  throw new Error(`Unexpected fixture parameters: ${url}`);
};
globalThis.fetch = fetchFixture as typeof fetch;
await import("../../src/bin/worker.js");
