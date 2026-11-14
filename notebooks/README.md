# Open-Meteo Weather notebooks

Run the visible bootstrap and connection cells in order, or open each notebook's Colab link. The shared release launcher handles Bun and the public worker release; no worker checkout or API key is needed. Fresh setup requires Git and internet access. Live provider failures remain errors; no data fallback is substituted.

1. [Two cities and daily time boundaries](01_weather_windows.ipynb): UTC intervals, hourly reconstruction and the GMT experiment.
2. [Weather codes and hourly selection](02_weather_codes_and_hourly_selection.ipynb): readable codes, terrain, current versus hourly weather, and an explicit wind rule.
3. [Air-quality index scales](03_air_quality_indices_are_different_scales.ipynb): distinct US/European labels and a numerical selection.

From this directory: `uv sync --locked`, then `uv run --locked vgi-notebooks`. Each notebook has an experiment command that saves a separate output. Colab installs only the base package and preserves compatible preloaded kernel/data/plotting libraries. The local runner extra is separate.

Shared [standard](https://github.com/Query-farm/vgi-example-notebooks/blob/main/docs/standard.md) and [runner](https://github.com/Query-farm/vgi-example-notebooks) live centrally. [coverage.json](coverage.json) distinguishes the executed release from current source. SVGs are the saved chart format. Default/experiment execution and preloaded-kernel compatibility are checked locally; the hosted Colab UI is not manually exercised.

Data: Open-Meteo under CC BY 4.0; air-quality data includes CAMS attribution linked in notebook03. All products are modeled, with retrieval timestamps retained; they are not station observations. Source values can change between live runs.
