// Parsing for Open-Meteo response blocks (hourly / daily / current) into the
// name-keyed column dicts that batchFromColumns() expects. Replaces trip.ts.
//
// hourly/daily blocks are parallel arrays (`time` + one array per variable);
// `current` blocks hold scalars. Times come back as unixtime seconds, which
// are true UTC whatever `timezone` was requested: the zone moves where the
// daily/hourly window starts (local midnight), never the instants themselves.
// So they go straight to Timestamp(us, UTC) with no correction.
//
// Do NOT subtract `utc_offset_seconds`. This code used to, on the belief that
// Open-Meteo shifts unixtime into local time; it doesn't (verified on every
// host we call — forecast, archive, air-quality, marine, climate, ensemble,
// previous-runs), so each non-GMT timestamp came out off by the offset —
// Tokyo's sunrise at 20:28 local.

import type { WeatherVar } from "./endpoints.js";

/**
 * Convert an Open-Meteo unixtime (seconds, already UTC) to microseconds-since-
 * epoch (BigInt) for a Timestamp(us, UTC) column. Returns null for
 * missing/non-finite input.
 */
export function unixToUtcMicros(unix: unknown): bigint | null {
  if (typeof unix !== "number" || !Number.isFinite(unix)) return null;
  return BigInt(Math.round(unix)) * 1_000_000n;
}

function coerce(value: unknown, v: WeatherVar): unknown {
  if (value === null || value === undefined) return null;
  switch (v.kind) {
    case "double": {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "int": {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case "bool":
      return Boolean(value);
    case "timestamp":
      return unixToUtcMicros(value);
  }
}

/**
 * Build the column dict for a block. `time` is always emitted as UTC micros.
 * For `current` blocks the block holds scalars → exactly one row; for
 * hourly/daily it holds parallel arrays → one row per `time` entry. A
 * missing/empty block yields zero rows.
 * Pass the daily response's UTC offset to also emit Arrow date32 day numbers;
 * pass NaN for a missing offset so dates stay unknown rather than guessed.
 */
export function parseBlock(
  block: any,
  variables: WeatherVar[],
  isCurrent: boolean,
  dailyUtcOffsetSeconds?: number,
): Record<string, any[]> {
  const cols: Record<string, any[]> = { time: [] };
  // Offset is used ONLY to label a calendar date, never to shift an instant.
  // Open-Meteo defines its daily boundaries with this response-level offset.
  const daily = dailyUtcOffsetSeconds !== undefined;
  if (daily) cols.date = [];
  for (const v of variables) cols[v.name] = [];

  if (!block) return cols;

  if (isCurrent) {
    cols.time.push(unixToUtcMicros(block.time));
    for (const v of variables) {
      cols[v.name].push(coerce(block[v.name], v));
    }
    return cols;
  }

  const times: unknown[] = Array.isArray(block.time) ? block.time : [];
  for (let row = 0; row < times.length; row++) {
    cols.time.push(unixToUtcMicros(times[row]));
    if (daily) {
      const seconds = times[row];
      cols.date.push(typeof seconds === "number" && Number.isFinite(seconds) && Number.isFinite(dailyUtcOffsetSeconds)
        ? Math.floor((seconds + dailyUtcOffsetSeconds!) / 86400)
        : null);
    }
    for (const v of variables) {
      const arr = block[v.name];
      cols[v.name].push(coerce(Array.isArray(arr) ? arr[row] : null, v));
    }
  }
  return cols;
}
