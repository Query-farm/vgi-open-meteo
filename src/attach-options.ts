// ATTACH-time options for the open_meteo catalog.
//
// We expose a single optional `apikey` option so commercial Open-Meteo
// customers can authenticate:
//
//   ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION '…', apikey 'YOUR_KEY');
//
// The mechanism mirrors vgi-typescript's examples/attach-options-worker.ts: the
// catalog advertises the option spec via catalogsInfo(), the DuckDB extension
// validates + casts the value, and the worker encodes the received options into
// `attach_opaque_data` so they survive pooled-worker reuse (stdio) and stateless
// HTTP dispatch. Each table function decodes them back out in process().
//
// Unlike the example, decoding is *lenient*: a free-tier ATTACH carries no
// apikey, so a missing/short payload simply yields `{}` (→ no key → free host).

import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import {
  type AttachOptionSpec,
  batchFromColumns,
  deserializeBatch,
  serializeBatch,
  type TableProcessParams,
} from "vgi";

const ATTACH_ID_SEP = 0x00;
const UUID_BYTES = 16;

/** The attach options advertised by the open_meteo catalog. */
export const ATTACH_OPTION_SPECS: AttachOptionSpec[] = [
  {
    name: "apikey",
    description:
      "Open-Meteo commercial API key. Omit for the free tier. When set, requests use the customer-* API hosts.",
    type: new Utf8(),
    default: "",
  },
];

const OPTIONS_SCHEMA = new Schema(
  ATTACH_OPTION_SPECS.map((s) => new Field(s.name, s.type as any, true)),
);

function randomUuidBytes(): Uint8Array {
  const buf = new Uint8Array(UUID_BYTES);
  crypto.getRandomValues(buf);
  return buf;
}

/**
 * Encode received ATTACH options into `attach_opaque_data`: a random UUID, a
 * 0x00 separator, then a 1-row IPC batch holding the (default-merged) option
 * values. Called from the catalog's attach() override.
 */
export function encodeAttachOpaqueData(received: Record<string, unknown>): Uint8Array {
  const columns: Record<string, unknown[]> = {};
  for (const spec of ATTACH_OPTION_SPECS) {
    const v = received[spec.name];
    columns[spec.name] = [v === undefined ? spec.default : v];
  }
  const ipc = serializeBatch(batchFromColumns(columns, OPTIONS_SCHEMA));
  const out = new Uint8Array(UUID_BYTES + 1 + ipc.byteLength);
  out.set(randomUuidBytes(), 0);
  out[UUID_BYTES] = ATTACH_ID_SEP;
  out.set(ipc, UUID_BYTES + 1);
  return out;
}

/**
 * Decode `attach_opaque_data` back into an options dict. Returns `{}` when the
 * payload is absent or doesn't carry an options batch (free-tier attach), so
 * callers can treat "no key" uniformly.
 */
export function decodeAttachOpaqueData(
  attachOpaqueData: Uint8Array | null | undefined,
): Record<string, unknown> {
  if (
    !attachOpaqueData ||
    attachOpaqueData.byteLength <= UUID_BYTES + 1 ||
    attachOpaqueData[UUID_BYTES] !== ATTACH_ID_SEP
  ) {
    return {};
  }
  try {
    const batch = deserializeBatch(attachOpaqueData.subarray(UUID_BYTES + 1));
    const result: Record<string, unknown> = {};
    for (const spec of ATTACH_OPTION_SPECS) {
      const col = batch.getChild(spec.name);
      if (col && batch.numRows > 0) result[spec.name] = col.get(0);
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Extract the Open-Meteo API key from a table function's process params, or
 * `undefined` when no (non-empty) key was supplied at ATTACH time.
 */
export function apiKeyFromParams(params: TableProcessParams<any>): string | undefined {
  const opts = decodeAttachOpaqueData(params.initCall?.bind_call?.attach_opaque_data ?? null);
  const key = opts.apikey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}
