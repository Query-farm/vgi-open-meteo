// Parsing for Open-Meteo response blocks (hourly / daily / current) into the
// name-keyed column dicts that batchFromColumns() expects. Replaces trip.ts.
//
// hourly/daily blocks are parallel arrays (`time` + one array per variable);
// `current` blocks hold scalars. Times come back as unixtime seconds — but
// Open-Meteo shifts them by the response's utc_offset_seconds when a timezone
// is set, so we subtract it to recover true UTC before emitting Timestamp(us).

import type { WeatherVar } from "./endpoints.js";

/**
 * Convert an Open-Meteo unixtime (seconds, tz-shifted by `utcOffsetSeconds`)
 * to true UTC microseconds-since-epoch (BigInt) for a Timestamp(us, UTC)
 * column. Returns null for missing/non-finite input.
 */
export function unixToUtcMicros(
  unix: unknown,
  utcOffsetSeconds: number,
): bigint | null {
  if (typeof unix !== "number" || !Number.isFinite(unix)) return null;
  return BigInt(Math.round(unix - utcOffsetSeconds)) * 1_000_000n;
}

function coerce(value: unknown, v: WeatherVar, utcOffsetSeconds: number): unknown {
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
      return unixToUtcMicros(value, utcOffsetSeconds);
  }
}

/**
 * Build the column dict for a block. `time` is always emitted as UTC micros.
 * For `current` blocks the block holds scalars → exactly one row; for
 * hourly/daily it holds parallel arrays → one row per `time` entry. A
 * missing/empty block yields zero rows.
 */
export function parseBlock(
  block: any,
  variables: WeatherVar[],
  utcOffsetSeconds: number,
  isCurrent: boolean,
): Record<string, any[]> {
  const cols: Record<string, any[]> = { time: [] };
  for (const v of variables) cols[v.name] = [];

  if (!block) return cols;

  if (isCurrent) {
    cols.time.push(unixToUtcMicros(block.time, utcOffsetSeconds));
    for (const v of variables) {
      cols[v.name].push(coerce(block[v.name], v, utcOffsetSeconds));
    }
    return cols;
  }

  const times: unknown[] = Array.isArray(block.time) ? block.time : [];
  for (let row = 0; row < times.length; row++) {
    cols.time.push(unixToUtcMicros(times[row], utcOffsetSeconds));
    for (const v of variables) {
      const arr = block[v.name];
      cols[v.name].push(coerce(Array.isArray(arr) ? arr[row] : null, v, utcOffsetSeconds));
    }
  }
  return cols;
}
