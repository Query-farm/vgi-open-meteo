// The weather functions' continued output, driven the way the client drives a
// table-in-out exchange: one real input batch, then zero-row CONTINUE ticks
// while the last reply said HAVE_MORE_OUTPUT. Between turns the function's
// state is round-tripped through the HTTP state-token encoding, as it is on
// Cloudflare / serve.ts, so a plan that only survives in memory fails here.
// Upstream is a fake fetch answering multi-location requests.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { OutputCollector } from "vgi-rpc";
import { Arguments, deserializeUserState, serializeUserState } from "vgi";
import { batchFromColumns, field, float64, schema, utf8, type VgiFunction } from "vgi/worker-cf";

import { blockFunctions, elevation, geocoding } from "../../src/functions.js";
import { _resetCaches } from "../../src/open-meteo.js";
import { REQUESTS_PER_REPLY } from "../../src/multi-location.js";

const STATUS = "vgi.status";
const fn = (name: string) => blockFunctions.find((f) => f.meta.name === name)!;

/** Every upstream URL the fake fetch saw. */
let requests: URL[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  _resetCaches();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    const lats = url.searchParams.get("latitude")!.split(",").map(Number);
    const lons = url.searchParams.get("longitude")!.split(",").map(Number);
    const starts = url.searchParams.get("start_date")?.split(",");
    const body = lats.map((lat, i) => ({
      latitude: lat,
      longitude: lons[i],
      timezone: "GMT",
      utc_offset_seconds: 0,
      elevation: 10,
      ...(i > 0 ? { location_id: i } : {}),
      // One current row whose temperature encodes the location, so a
      // misattributed location shows up as a wrong value on its row.
      current: { time: 1704067200, interval: 900, temperature_2m: lat * 1000 + lons[i] },
      daily: {
        time: Array.from({ length: starts ? 2 : 1 }, (_, k) => 1704067200 + k * 86400),
        temperature_2m_max: Array.from({ length: starts ? 2 : 1 }, () => lat),
      },
    }));
    return Response.json(lats.length === 1 ? body[0] : body);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetCaches();
});

interface Reply {
  rows: Record<string, unknown>[];
  parents: number[];
  more: boolean;
}

function decodeParents(md: Map<string, string> | undefined, n: number): number[] {
  const b64 = md?.get("vgi_rpc.parent_row#b64");
  if (!b64) return Array.from({ length: n }, (_, i) => i);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return Array.from(new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
}

/** Run one input batch to completion: process, then a tick per "more". */
async function drive(f: VgiFunction, input: Record<string, unknown[]>, named: Record<string, unknown> = {}): Promise<Reply[]> {
  const fields = Object.keys(input).map((k) => field(k, k.endsWith("_date") ? utf8() : float64(), true));
  const inputSchema = schema(fields);
  const bindCall = {
    function_name: f.meta.name,
    arguments: new Arguments([], new Map(Object.entries(named))),
    function_type: 1,
    input_schema: inputSchema,
    settings: null,
    secrets: null,
    attach_opaque_data: null,
    transaction_opaque_data: null,
    resolved_secrets_provided: false,
  };
  const bound = await (f as any).bind(bindCall);
  const init = {
    bind_call: bindCall,
    output_schema: bound.output_schema,
    bind_opaque_data: null,
    projection_ids: null,
    pushdown_filters: null,
    join_keys: [],
    phase: 0,
    finalize_state_id: null,
    split_tokens: null,
    execution_id: null,
    substream_id: null,
  };
  const handlers = (f as any).createStreamHandlers(init, { max_workers: 1, execution_id: new Uint8Array(16), opaque_data: null });
  const eState = handlers.exchangeInit();
  const replies: Reply[] = [];
  let batch = batchFromColumns(input, inputSchema);
  let inputMetadata: Map<string, string> | undefined;
  for (let turn = 0; turn < 100; turn++) {
    // The tick's status rides its batch metadata; vgi-rpc also surfaces it on
    // the collector, which is the carrier used here.
    const out = new OutputCollector(handlers.outputSchema, false, "", null, undefined, undefined, undefined, { inputMetadata });
    await handlers.exchangeFn(eState, batch, out);
    const emitted = out.batches[out.dataBatchIdx!];
    const md = new Map<string, string>([...((emitted.batch as any).metadata ?? []), ...(emitted.metadata ?? [])]);
    const rows: Record<string, unknown>[] = [];
    for (let r = 0; r < emitted.batch.numRows; r++) {
      const row: Record<string, unknown> = {};
      for (const fld of emitted.batch.schema.fields) row[fld.name] = emitted.batch.getChild(fld.name)?.get(r);
      rows.push(row);
    }
    const more = md.get(STATUS) === "HAVE_MORE_OUTPUT";
    replies.push({ rows, parents: decodeParents(md, rows.length), more });
    if (!more) return replies;
    // HTTP: the state reaches the next turn only through the token encoding.
    eState.state = deserializeUserState(serializeUserState(eState.state));
    batch = batchFromColumns(Object.fromEntries(Object.keys(input).map((k) => [k, []])), inputSchema);
    inputMetadata = new Map([[STATUS, "CONTINUE"]]);
  }
  throw new Error("never finished");
}

test("weather functions declare input_rows_per_call; elevation and geocoding match their upstream batches", () => {
  for (const f of blockFunctions) expect(f.meta.inputRowsPerCall).toBe(256);
  expect(elevation.meta.inputRowsPerCall).toBe(100);
  expect(geocoding.meta.inputRowsPerCall).toBe(8);
});

test("a call's locations go out as multi-location requests, several replies, each row on its own parent", async () => {
  // 50 distinct points + a duplicate + a NULL. forecast_current: 11 variables =
  // 1.1 weighted calls per location, so 9 per request and 36 per reply.
  const lat: (number | null)[] = Array.from({ length: 50 }, (_, i) => 40 + i * 0.25);
  const lon: (number | null)[] = Array.from({ length: 50 }, (_, i) => -3 + i * 0.25);
  lat.push(lat[7], null);
  lon.push(lon[7], 5);
  const replies = await drive(fn("forecast_current"), { latitude: lat, longitude: lon });

  expect(replies.map((r) => r.more)).toEqual([true, false]);
  expect(requests.length).toBe(6); // ceil(50 / 9)
  expect(replies[0].rows.length).toBe(36 + 1); // 4 requests; location 7 serves rows 7 and 50
  for (const u of requests) {
    expect(u.searchParams.get("latitude")!.split(",").length).toBeLessThanOrEqual(9);
  }

  const all = replies.flatMap((r) => r.rows.map((row, k) => ({ row, parent: r.parents[k] })));
  expect(all.length).toBe(51); // the NULL row is dropped
  expect(new Set(all.map((x) => x.parent)).size).toBe(51);
  for (const { row, parent } of all) {
    expect(row.temperature_2m).toBeCloseTo(lat[parent]! * 1000 + lon[parent]!, 6);
    expect(row.grid_latitude).toBe(lat[parent]);
  }
});

test("a single location is one request answered with a bare object, in one reply", async () => {
  const replies = await drive(fn("forecast_current"), { latitude: [52.52], longitude: [13.41] });
  expect(replies.length).toBe(1);
  expect(replies[0].more).toBe(false);
  expect(replies[0].rows[0].temperature_2m).toBeCloseTo(52.52 * 1000 + 13.41, 6);
  expect(requests.length).toBe(1);
});

test("an all-NULL batch answers with one empty reply and no request", async () => {
  const replies = await drive(fn("forecast_current"), { latitude: [null, null], longitude: [1, null] });
  expect(replies).toEqual([{ rows: [], parents: [], more: false }]);
  expect(requests.length).toBe(0);
});

test("required dates travel as per-location lists; same point, other dates is another location", async () => {
  const replies = await drive(fn("historical_daily"), {
    latitude: [52.52, 52.52, 35.69, 52.52],
    longitude: [13.41, 13.41, 139.69, 13.41],
    start_date: ["2024-06-01", "2024-01-01", "2024-06-01", "2024-06-01"],
    end_date: ["2024-06-02", "2024-01-02", "2024-06-02", "2024-06-02"],
  });
  expect(requests.length).toBe(1);
  expect(requests[0].searchParams.get("latitude")).toBe("52.52,52.52,35.69");
  expect(requests[0].searchParams.get("start_date")).toBe("2024-06-01,2024-01-01,2024-06-01");
  expect(requests[0].searchParams.get("end_date")).toBe("2024-06-02,2024-01-02,2024-06-02");
  const rows = replies.flatMap((r) => r.parents);
  expect(rows.sort()).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
});

test("a reply holds at most REQUESTS_PER_REPLY requests", async () => {
  const n = 9 * REQUESTS_PER_REPLY * 2 + 1;
  const lat = Array.from({ length: n }, (_, i) => -60 + i * 0.5);
  const lon = Array.from({ length: n }, () => 10);
  const replies = await drive(fn("forecast_current"), { latitude: lat, longitude: lon });
  expect(replies.map((r) => r.more)).toEqual([true, true, false]);
  expect(replies.map((r) => r.rows.length)).toEqual([36, 36, 1]);
});
