import { expect, test } from "bun:test";
import {
  callWeight,
  emptyPlan,
  type LocationInput,
  MAX_LOCATIONS_PER_REQUEST,
  planCall,
  rangeDays,
  REQUEST_WEIGHT_BUDGET,
  requestRange,
  rowsOfLocation,
  splitLocations,
} from "../../src/multi-location.js";

const at = (lat: number, lon: number, start = "", end = ""): LocationInput => ({ lat, lon, start, end });
const unit = () => 1;

test("call weight follows Open-Meteo's fractional counting", () => {
  expect(callWeight(5, 7)).toBe(1);
  expect(callWeight(10, 14)).toBe(1);
  expect(callWeight(20, 28)).toBe(4); // the documented "4 weeks and 20 variables = 4 calls"
  expect(callWeight(17, 7)).toBeCloseTo(1.7);
  expect(rangeDays("2024-06-01", "2024-06-07")).toBe(7);
  expect(rangeDays("2024-02-28", "2024-03-01")).toBe(3);
  expect(rangeDays("2024-06-07", "2024-06-01")).toBe(1); // upstream rejects it; price it as one
  expect(rangeDays("nonsense", "2024-06-01")).toBe(1);
});

test("planCall dedupes locations, drops NULL rows and keeps every duplicate row", () => {
  const plan = emptyPlan();
  planCall(plan, [at(52.52, 13.41), null, at(35.69, 139.69), at(52.52, 13.41), at(64.15, -21.94)], unit);
  expect(plan.lat).toEqual([52.52, 35.69, 64.15]);
  expect(plan.lon).toEqual([13.41, 139.69, -21.94]);
  expect(rowsOfLocation(plan, 0)).toEqual([0, 3]);
  expect(rowsOfLocation(plan, 1)).toEqual([2]);
  expect(rowsOfLocation(plan, 2)).toEqual([4]);
  expect(plan.requestEnd).toEqual([3]); // one request
  expect(plan.next).toBe(0);
});

test("rows with the same coordinates but different required dates are distinct locations", () => {
  const plan = emptyPlan();
  planCall(plan, [
    at(52.52, 13.41, "2024-06-01", "2024-06-07"),
    at(52.52, 13.41, "2024-01-01", "2024-01-07"),
    at(52.52, 13.41, "2024-06-01", "2024-06-07"),
  ], unit);
  expect(plan.start).toEqual(["2024-06-01", "2024-01-01"]);
  expect(plan.end).toEqual(["2024-06-07", "2024-01-07"]);
  expect(rowsOfLocation(plan, 0)).toEqual([0, 2]);
  // Archive/climate take per-location date lists, so they still share a request.
  expect(plan.requestEnd).toEqual([2]);
});

test("planCall packs requests by weight budget and location cap", () => {
  const plan = emptyPlan();
  const inputs = Array.from({ length: 25 }, (_, i) => at(i, i));
  planCall(plan, inputs, () => 2); // 5 locations fit a budget of 10
  expect(REQUEST_WEIGHT_BUDGET).toBe(10);
  expect(plan.requestEnd).toEqual([5, 10, 15, 20, 25]);
  expect(requestRange(plan, 0)).toEqual([0, 5]);
  expect(requestRange(plan, 4)).toEqual([20, 25]);

  const cheap = emptyPlan();
  planCall(cheap, Array.from({ length: 250 }, (_, i) => at(i / 10, i / 10)), () => 0.01);
  expect(cheap.requestEnd).toEqual([MAX_LOCATIONS_PER_REQUEST, 200, 250]);

  // A location over budget on its own still gets a request of its own.
  const heavy = emptyPlan();
  planCall(heavy, [at(1, 1), at(2, 2), at(3, 3)], () => 50);
  expect(heavy.requestEnd).toEqual([1, 2, 3]);
});

test("planCall replaces the previous input's plan and handles an all-NULL batch", () => {
  const plan = emptyPlan();
  planCall(plan, [at(1, 1), at(2, 2)], unit);
  plan.next = 1;
  planCall(plan, [null, null], unit);
  expect(plan.lat).toEqual([]);
  expect(plan.requestEnd).toEqual([]);
  expect(plan.next).toBe(0);
  expect(plan.rowStart).toEqual([0]);
});

test("the plan is plain data (it rides the HTTP state token)", () => {
  const plan = emptyPlan();
  planCall(plan, [at(52.52, 13.41, "2024-06-01", "2024-06-02"), at(35.69, 139.69, "2024-06-01", "2024-06-02")], unit);
  const copy = JSON.parse(JSON.stringify(plan));
  expect(copy).toEqual(plan);
  for (const v of Object.values(plan)) {
    expect(typeof v === "number" || Array.isArray(v)).toBe(true);
  }
});

test("splitLocations accepts a bare object for one location and an ordered array for many", () => {
  const one = { latitude: 52.5, hourly: { time: [1] } };
  expect(splitLocations(one, 1)).toEqual([one]);
  const many = [{ latitude: 52.5 }, { latitude: 35.7, location_id: 1 }, { latitude: 64.1, location_id: 2 }];
  expect(splitLocations(many, 3)).toEqual(many);
  // A single location requested as a list still answers with a 1-element array.
  expect(splitLocations([one], 1)).toEqual([one]);
});

test("splitLocations refuses anything that could misattribute a location", () => {
  expect(() => splitLocations([{}, {}], 3)).toThrow("2 locations");
  expect(() => splitLocations({ latitude: 1 }, 2)).toThrow("unexpected body");
  expect(() => splitLocations(null, 1)).toThrow("unexpected body");
  expect(() => splitLocations([{}, { location_id: 2 }, { location_id: 1 }], 3)).toThrow("location_id 2 in slot 1");
});
