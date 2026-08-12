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
//   * The `require` polyfill. vgi-rpc writes to the stdio transport through a
//     synchronous `node:fs.writeSync`, reached via `import.meta.require` (Bun)
//     or `globalThis.require` (Node CJS). Under Node ESM neither exists, and
//     the worker dies on its first write with "IpcStreamWriter requires Bun or
//     Node.js CJS" — its own source says ESM consumers must polyfill require.
//     Doing it here rather than shipping CJS is deliberate: a CJS bundle of
//     this dependency tree still contains `import.meta` references, which are
//     a syntax error outside a module.
//
// `??=` so a runtime that already has one (Bun, or Node CJS) keeps it.

import { mkdir, rm } from "node:fs/promises";

const BANNER = [
  "#!/usr/bin/env node",
  'import { createRequire as __vgiCreateRequire } from "node:module";',
  "globalThis.require ??= __vgiCreateRequire(import.meta.url);",
].join("\n");

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
