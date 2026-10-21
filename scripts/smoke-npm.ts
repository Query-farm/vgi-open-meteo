// Exercise the published Node bundle over its actual IPC transport.
import { VgiClient } from "vgi";
import { subprocessConnect } from "vgi-rpc";

const rpc = subprocessConnect(["node", "dist/worker.mjs"]);
const timeout = setTimeout(() => {
  console.error("Node bundle did not complete its catalog handshake within 15 seconds");
  rpc.close();
  process.exit(1);
}, 15_000);
try {
  const client = new VgiClient(rpc);
  const catalogs = await client.catalogs();
  if (!catalogs.includes("open_meteo")) throw new Error(`Missing catalog: ${catalogs}`);
  const attached = await client.catalogAttach("open_meteo");
  const functions = await client.schemaContentsFunctions(attached.attach_opaque_data, "main", "TABLE_FUNCTION");
  if (!functions.some(fn => fn.name === "forecast_hourly")) throw new Error("Missing forecast_hourly function");
  console.log(`Node bundle: catalog handshake and ${functions.length} function schemas passed`);
} finally {
  clearTimeout(timeout);
  rpc.close();
}
