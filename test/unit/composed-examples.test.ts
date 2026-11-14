import { expect, test } from "bun:test";
import { openMeteoCatalog } from "../../src/catalog.js";
import { COMPOSED_EXAMPLES, COMPOSED_EXAMPLES_BY_FUNCTION } from "../../src/composed-examples.js";
import { allWeatherFunctions } from "../../src/functions.js";

type Example = { description: string; sql: string };
const examplesOf = (tags: Record<string, string> | undefined): Example[] =>
  JSON.parse(tags?.["vgi.example_queries"] ?? "[]");

test("every composed example is on the schema-level list", () => {
  const schemaSql = examplesOf(openMeteoCatalog.schemas[0]!.tags).map((e) => e.sql);
  for (const ex of COMPOSED_EXAMPLES) expect(schemaSql).toContain(ex.sql);
});

test("composed examples sit within the driving function's first five examples", () => {
  for (const [name, composed] of Object.entries(COMPOSED_EXAMPLES_BY_FUNCTION)) {
    const fn = allWeatherFunctions.find((f) => f.meta.name === name);
    expect(fn).toBeDefined();
    const firstFive = examplesOf(fn!.meta.tags as Record<string, string>).slice(0, 5).map((e) => e.sql);
    for (const ex of composed) expect(firstFive).toContain(ex.sql);
  }
});

test("composed examples combine at least two catalog functions and are ordered", () => {
  const names = allWeatherFunctions.map((f) => f.meta.name);
  for (const ex of COMPOSED_EXAMPLES) {
    const used = names.filter((n) => ex.sql.includes(`open_meteo.main.${n}(`));
    expect(used.length).toBeGreaterThanOrEqual(2);
    expect(ex.sql).toContain("ORDER BY");
    expect(ex.description.length).toBeGreaterThan(0);
  }
});
