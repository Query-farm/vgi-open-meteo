// Build the npm-publishable bundles.
//
// The repo runs on Bun, but the published package has to run under plain
// `node`, because that is what `npx` gives you — and what DuckDB spawns when a
// worker is attached with `LOCATION 'npx -y @query-farm/vgi-open-meteo'`. So
// each entry is bundled with its dependencies into a single self-contained
// file: the tarball then carries no node_modules and no install step of its
// own, which is what keeps `npx` startup to one download.
//
// Two things in the banner are load-bearing:
//
//   * The shebang. npm makes `bin` targets executable, but the kernel still
//     needs to be told what interprets them.
// This used to also inject a `require` polyfill: vgi-rpc reaches its
// synchronous `node:fs.writeSync` through `import.meta.require` (Bun) or
// `globalThis.require` (Node CJS), and Node ESM has neither, so the worker died
// on its first write. vgi-rpc 0.19.4 falls back to `process.getBuiltinModule`,
// which is how Node ESM reaches a builtin synchronously, so the shim is gone
// from here. Keep the dependency at >= 0.19.4 or it comes back.

import { mkdir, rm } from "node:fs/promises";

const BANNER = "#!/usr/bin/env node";

// Only the stdio worker ships to npm. `src/bin/serve.ts` calls `Bun.serve`,
// which is a ReferenceError under plain node — and npx gives you node. HTTP
// serving is the Docker image's job, and that runs Bun. Bundling serve.ts here
// would ship a binary that crashes on first run.
const ENTRIES = [{ in: "src/bin/worker.ts", out: "worker.mjs" }];

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

for (const entry of ENTRIES) {
  const result = await Bun.build({
    entrypoints: [entry.in],
    outdir: "dist",
    target: "node",
    format: "esm",
    banner: BANNER,
    naming: { entry: entry.out },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed: ${entry.in}`);
  }
  const bytes = (await Bun.file(`dist/${entry.out}`).arrayBuffer()).byteLength;
  console.log(`  dist/${entry.out}  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

console.log("built dist/ for npm");
