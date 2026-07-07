// Entry point for the Open-Meteo VGI worker (stdio + AF_UNIX launcher transports).
//
// DuckDB spawns this binary with `ATTACH 'open_meteo' AS m (TYPE vgi, LOCATION
// '… worker.ts')` for stdio mode. The OpenMeteoCatalog interface advertises the
// optional `apikey` ATTACH option and threads it through to the functions.

import { FunctionRegistry, Worker } from "vgi";
import { buildRegistry, openMeteoCatalog, OpenMeteoCatalog } from "../catalog.js";

const registry = buildRegistry(new FunctionRegistry());

const worker = new Worker({
  catalog: openMeteoCatalog,
  catalogInterfaceFactory: () => new OpenMeteoCatalog(openMeteoCatalog, registry),
});
worker.run();
