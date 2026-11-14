<a href="https://query.farm/"><img src="assets/query-farm-strata-sun.svg" alt="Query.Farm — Strata Sun" width="230"></a>

# Open-Meteo SQL notebooks

[01 · Two cities, three days, one careful clock](01_weather_windows.ipynb) compares
Tokyo and Reykjavik using live forecast responses. It resolves place names, records
coverage and response provenance, draws hourly temperature and precipitation,
and compares provider daily summaries with SQL aggregation over the matching
physical intervals. A final experiment changes only the day boundary from local
midnight to UTC midnight.

Saved outputs are a real public API run, not recorded input fixtures. Their actual
retrieval times appear in the notebook. Re-execution fetches new forecasts and can
change results. Forecasts, including forecast rows for elapsed hours, are modeled
weather; this notebook contains no station observations and measures no forecast
error. There is no fabricated or offline fallback.

## Environment

From this `notebooks/` directory, with Bun, Git and uv installed:

```sh
uv sync --locked
uv run --locked python execute.py
```

The separate `uv.lock` pins Haybarn 2.0.0rc11 (VGI protocol 3.3 compatible with
this worker), JupySQL, pandas, Seaborn and Matplotlib. It leaves the root Bun
runtime and dependency pins unchanged. The visible SQL uses literal
`bun run github_worker.ts Query-farm/vgi-open-meteo 67b18aedaf207cfea721121968bbec4ea0e0f735 src/bin/worker.ts`.
The [launcher](github_worker.ts) fetches that immutable Git commit, verifies HEAD,
installs its dependencies with `bun install --frozen-lockfile`, and runs the worker.
No manually prepared source checkout or build is needed. The revision corresponds
to release v0.4.0; that release has no native assets, and its declared npm package
returned 404 during verification. The launcher does not substitute a local worker.

The cache is `${XDG_CACHE_HOME:-~/.cache}/vgi-notebook-workers/Query-farm/vgi-open-meteo/`
keyed by commit and Bun version. A lock serializes first installation; interrupted
setup fails explicitly. Remove only the matching cache directory to reinstall.
Setup diagnostics use stderr because stdout carries Arrow. This was verified with
Bun 1.3.14 and Haybarn 2.0.0rc11. To upgrade, update the literal full Git commit,
review its lockfile, and rerun both notebook settings. GitHub/npm access is needed
on first setup, plus Open-Meteo access on every live run. No API key or commercial account is used.

The runner creates a temporary kernel specification for its own Python interpreter;
no global Jupyter kernel is required. Start kernels in this notebook directory;
copied experiment directories include the same helpers and run independently. In VS Code, select the Python environment at
`notebooks/.venv/bin/python`, edit the visible parameters, then **Restart Kernel →
Run All**. If your Jupyter frontend needs a named kernel, register one explicitly:

```sh
uv run --locked python -m ipykernel install --user --name vgi-open-meteo-notebooks --display-name "Python (vgi-open-meteo notebooks)"
```

## Run the single-parameter experiment

```sh
uv run --locked python execute.py --parameters '{"DAY_BOUNDARY":"GMT"}' --output-dir artifacts/gmt
```

The runner saves only after successful execution. Overrides require a distinct
destination and cannot overwrite the canonical default. Experiment copies include
local assets, this guide, the standard, and execution helpers for direct review.
`artifacts/`, local kernels/environments and chart extractions are ignored by Git.

Only two places and one to five selected days are accepted. Geocoding resolves
one candidate per name; review its country and timezone before interpreting
results. The worker fetches one hourly product over a bounded padded UTC window
and one daily product per selected location, materialized once as ordinary
in-memory tables. It batches weather locations upstream where possible. A SQL
projection does not reduce the worker's fixed upstream variable list. Public API
limits or upstream failures stop execution rather than silently changing data.

Temperature is °C, precipitation is mm water equivalent, wind speed is m/s.
Provider days use the response's fixed UTC offset, not a reconstructed civil
calendar across daylight-saving transitions. Retrieval is not model issuance;
`best_match` does not identify every contributing model. Hourly and daily requests
are separate snapshots, so a small reconciliation difference is a diagnostic,
not proof of an implementation error.

## Repository validation

The repository’s SQL suites can use the supported Haybarn test runner through the
existing Makefile override, without rebuilding or changing the worker:

```sh
make typecheck
bun run test
make test-semantic
make test-stdio TEST_RUNNER='haybarn-unittest --keep-home'
# Allow the public API quota to recover before the second live suite.
make test-http TEST_RUNNER='haybarn-unittest --keep-home' HTTP_PORT=18783
```

These commands were checked with `haybarn-unittest` 2.0.0rc11. The default local
in-tree runner available during authoring used protocol 3.2 and failed at attach;
the unchanged worker requires protocol 3.3. The notebook’s locked Haybarn runtime
already supports that protocol. Keep the original failure logs separate from the
supported-runner results when reproducing validation.

The [notebook standard](STANDARD.md) specifies branding, folded Python, visible SQL,
parameter experiments and review. Official unchanged Strata Sun and VGI logos
were copied from the approved `vgi-perps/notebooks/assets/` assets, originally from
the Query.Farm website media kit.

Sources: [Open-Meteo forecast documentation](https://open-meteo.com/en/docs),
[geocoding documentation](https://open-meteo.com/en/docs/geocoding-api),
[historical reanalysis documentation](https://open-meteo.com/en/docs/historical-weather-api).
Data: Open-Meteo, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

<a href="https://query.farm/"><img src="assets/query-farm-strata-sun.svg" alt="Query.Farm — Strata Sun" width="230"></a>
