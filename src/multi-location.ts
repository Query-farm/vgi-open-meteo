// Multi-location planning for the weather block functions.
//
// Every Open-Meteo weather host takes comma-separated `latitude`/`longitude`
// lists and answers with a JSON ARRAY of per-location result objects, in the
// order the coordinates were sent (each but the first carries `location_id`,
// its 0-based index). A single coordinate still gets a bare object. Verified
// live (2026-10) on forecast, archive, air-quality, marine, flood, climate,
// previous-runs and ensemble:
//
//   - `timezone=auto` resolves per location (Berlin / Tokyo / Reykjavik in one
//     request each come back in their own zone); a constant zone applies to all.
//   - archive and climate accept per-location `start_date`/`end_date` lists of
//     the same length as the coordinates (ranges may differ in length), so rows
//     with different required dates still share a request.
//   - one invalid location (latitude 95, or end before start) fails the whole
//     request with HTTP 400 — the same outcome as before, when that row's own
//     request failed the query.
//   - no documented location cap; elevation documents 100, which we keep as the
//     ceiling here too. 100 coordinates is a ~2 KB query string (~4.5 KB with
//     date lists), far below any URL limit.
//   - size: a 16-day, 17-variable hourly forecast is ~34 KB of JSON per
//     location (100 locations: 3.4 MB, ~3 s; 25: 0.86 MB, ~1.5 s).
//
// Open-Meteo bills by *weighted* API calls, not requests: each location counts
// once, more for over 10 variables or over two weeks (`callWeight`). So packing
// locations into one request saves round trips and per-request latency, not
// quota. The request budget is therefore expressed in that same currency.
//
// The plan is the function's continuation STATE, so it holds only inputs and
// positions — the distinct locations, which input rows each serves, where each
// request ends, and the next request to send — never fetched output. Over HTTP
// it rides the per-turn state token, so it must stay small; `inputRowsPerCall`
// on the weather functions bounds it.

/** Most locations in one upstream request (elevation's documented cap). */
export const MAX_LOCATIONS_PER_REQUEST = 100;

/**
 * Weighted Open-Meteo API calls one upstream request may spend. A location
 * costing more than this alone still gets its own request.
 */
export const REQUEST_WEIGHT_BUDGET = 10;

/** Upstream requests fetched concurrently for ONE reply. */
export const REQUESTS_PER_REPLY = 4;

/** Characters of per-location query text (coordinates + dates) per request. */
export const REQUEST_URL_BUDGET = 6000;

/** A distinct location (with its required dates, if the endpoint takes them). */
export interface LocationInput {
  lat: number;
  lon: number;
  /** "" when the endpoint takes no date range. */
  start: string;
  end: string;
}

/**
 * Continuation state of one weather call. Plain arrays of numbers/strings so
 * it serializes into the HTTP state token (no Maps, no nested objects).
 */
export interface WeatherPlan {
  /** Distinct locations, in first-seen order. */
  lat: number[];
  lon: number[];
  start: string[];
  end: string[];
  /** Input rows per location, concatenated; location i owns rows[rowStart[i]..rowStart[i+1]). */
  rows: number[];
  rowStart: number[];
  /** Exclusive end location index of each upstream request. */
  requestEnd: number[];
  /** Next request to send. */
  next: number;
}

export function emptyPlan(): WeatherPlan {
  return { lat: [], lon: [], start: [], end: [], rows: [], rowStart: [0], requestEnd: [], next: 0 };
}

/** Inclusive day count of a yyyy-mm-dd range, or 1 when it can't be read. */
export function rangeDays(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Open-Meteo's weighted cost of one location: 1, scaled up for more than 10
 * variables and for more than 14 days ("4 weeks and 20 variables = 4 calls").
 */
export function callWeight(variables: number, days: number): number {
  return Math.max(1, variables / 10) * Math.max(1, days / 14);
}

/**
 * Fill `plan` for one input batch: dedupe the rows' locations (rows whose
 * coordinates — and dates, where required — match share one location and one
 * upstream slot) and pack them, in order, into requests bounded by
 * MAX_LOCATIONS_PER_REQUEST, REQUEST_WEIGHT_BUDGET and REQUEST_URL_BUDGET.
 * `inputs[k]` is row `k`'s location, or null for a row that is dropped (NULL
 * coordinates or dates: a 1->0 fan-out). `weight` prices one location.
 */
export function planCall(
  plan: WeatherPlan,
  inputs: (LocationInput | null)[],
  weight: (loc: LocationInput) => number,
): void {
  const fresh = emptyPlan();
  const byKey = new Map<string, number>();
  const rowsOf: number[][] = [];
  for (let row = 0; row < inputs.length; row++) {
    const loc = inputs[row];
    if (loc === null) continue;
    const key = `${loc.lat},${loc.lon},${loc.start},${loc.end}`;
    let idx = byKey.get(key);
    if (idx === undefined) {
      idx = fresh.lat.length;
      byKey.set(key, idx);
      fresh.lat.push(loc.lat);
      fresh.lon.push(loc.lon);
      fresh.start.push(loc.start);
      fresh.end.push(loc.end);
      rowsOf.push([]);
    }
    rowsOf[idx].push(row);
  }
  for (const rows of rowsOf) {
    for (const r of rows) fresh.rows.push(r);
    fresh.rowStart.push(fresh.rows.length);
  }

  let count = 0;
  let spent = 0;
  let chars = 0;
  for (let i = 0; i < fresh.lat.length; i++) {
    const loc = { lat: fresh.lat[i], lon: fresh.lon[i], start: fresh.start[i], end: fresh.end[i] };
    const w = weight(loc);
    const c = String(loc.lat).length + String(loc.lon).length + loc.start.length + loc.end.length + 4;
    if (count > 0 && (count >= MAX_LOCATIONS_PER_REQUEST || spent + w > REQUEST_WEIGHT_BUDGET || chars + c > REQUEST_URL_BUDGET)) {
      fresh.requestEnd.push(i);
      count = 0;
      spent = 0;
      chars = 0;
    }
    count++;
    spent += w;
    chars += c;
  }
  if (count > 0) fresh.requestEnd.push(fresh.lat.length);
  Object.assign(plan, fresh);
}

/** Location index range [from, to) of request `r`. */
export function requestRange(plan: WeatherPlan, r: number): [number, number] {
  return [r === 0 ? 0 : plan.requestEnd[r - 1], plan.requestEnd[r]];
}

/** The input rows location `i` serves (its duplicates included). */
export function rowsOfLocation(plan: WeatherPlan, i: number): number[] {
  return plan.rows.slice(plan.rowStart[i], plan.rowStart[i + 1]);
}

/**
 * Split a multi-location response into one result object per requested
 * location. One coordinate comes back as a bare object, several as an array in
 * request order; anything else — a wrong length, or a `location_id` that isn't
 * the slot it sits in — throws rather than attribute weather to the wrong row.
 */
export function splitLocations(data: unknown, expected: number): any[] {
  const list = Array.isArray(data) ? data : expected === 1 && data != null && typeof data === "object" ? [data] : null;
  if (list === null || list.length !== expected) {
    throw new Error(
      `Open-Meteo returned ${Array.isArray(data) ? `${data.length} locations` : "an unexpected body"} ` +
        `for a request of ${expected}`,
    );
  }
  for (let i = 0; i < list.length; i++) {
    const id = list[i]?.location_id;
    if (id !== undefined && id !== null && Number(id) !== i) {
      throw new Error(`Open-Meteo returned location_id ${id} in slot ${i}`);
    }
  }
  return list;
}
