"""Offline acceptance tests using the VGI reference semantic compiler.

Run `make test-semantic` with a vgi-lint-check checkout (VGI_LINT_PROJECT).
The real worker runs against fixed HTTP fixtures; no provider calls are made.
"""
from pathlib import Path
from datetime import date, datetime, timezone
import json
import math
import shlex

import haybarn
from vgi_lint_check.loader import build_catalog
from vgi_lint_check.semantic_model import build_semantic_model, schema_diagnostics
from vgi_lint_check.semantic_compiler import execute_semantic_query
from vgi_lint_check.snapshot import take_snapshot, fetch_function_arguments

CATALOG = "farm.query.open_meteo"
worker = "bun run " + shlex.quote(str(Path(__file__).with_name("worker.ts").resolve()))
con = haybarn.connect()
con.execute("LOAD vgi")
con.execute("SET TimeZone = 'UTC'")
con.execute("ATTACH 'open_meteo' AS weather (TYPE vgi, LOCATION '" + worker.replace("'", "''") + "')")
catalog = build_catalog(take_snapshot(con), "weather", worker,
                        catalog_name="open_meteo", argument_rows=fetch_function_arguments(con, "weather"))
assert not schema_diagnostics(catalog), schema_diagnostics(catalog)
model = build_semantic_model(catalog)
assert not model.diagnostics, model.diagnostics
assert len(model.entities) == 10
assert len(model.relationships) == 5


def entity(name):
    return {"catalog_id": CATALOG, "entity_id": name}


def member(name, field):
    return {**entity(name), "member_id": field}


def normalized(cell):
    # TIMESTAMPTZ display follows the client timezone; compare the actual instant.
    if isinstance(cell, str) and len(cell) > 10 and cell[10] == "T":
        cell = datetime.fromisoformat(cell)
    if isinstance(cell, datetime):
        return cell.astimezone(timezone.utc).isoformat()
    return cell.isoformat() if isinstance(cell, date) else cell


def run(name, request, expected, units=None, catalogs=None):
    result = execute_semantic_query(catalogs or {"weather": catalog}, con.cursor(), request)
    assert result["ok"], (name, result)
    rows = [[normalized(cell) for cell in row] for row in result["result"]["rows"]]
    assert rows == expected, (name, rows, expected)
    if units:
        for key, value in units.items():
            assert result["plan"]["output_units"][key] == value, (name, result["plan"])
    print(f"PASS {name}")
    return result


params = {"latitude": 35.69, "longitude": 139.69, "forecast_days": 7}
daily_measures = [member("forecast_daily", field) for field in
                  ["total_precipitation", "highest_temperature", "lowest_temperature",
                   "total_precipitation_hours", "days_with_precipitation", "precipitation_days_with_data", "temperature_days_with_data"]]
run("weekly totals, extremes, missing data and duration units", {
    "measures": daily_measures, "parameters": params,
}, [[24.0, 25.0, 6.0, 7.0, 4, 6, 5]], {"total_precipitation": "mm", "total_precipitation_hours": "h", "highest_temperature": "Cel"})

run("Fahrenheit leaves precipitation duration in hours", {
    "measures": [member("forecast_daily", "highest_temperature"), member("forecast_daily", "total_precipitation_hours")],
    "parameters": {**params, "temperature_unit": "fahrenheit", "precipitation_unit": "inch"},
}, [[77.0, 7.0]], {"highest_temperature": "[degF]", "total_precipitation_hours": "h"})

# DATE values are returned by the semantic tool as ISO strings.
run("Tokyo daily labels use local dates, even in a different client timezone", {
    "dimensions": [member("forecast_daily", "date")],
    "measures": [member("forecast_daily", "total_precipitation")],
    "parameters": params, "order": [{"member": "date", "direction": "asc"}], "limit": 2,
}, [["2024-01-01", 4.0], ["2024-01-02", 0.0]])
con.execute("SET TimeZone = 'America/New_York'")
run("local dates are independent of DuckDB session timezone", {
    "root_entity": entity("forecast_daily"),
    "dimensions": [member("forecast_daily", "date")], "parameters": params,
    "order": [{"member": "date", "direction": "asc"}], "limit": 1,
}, [["2024-01-01"]])
con.execute("SET TimeZone = 'UTC'")

run("readable current weather", {
    "root_entity": entity("forecast_current"),
    "dimensions": [member("forecast_current", "temperature_2m"), member("weather_codes", "description")],
    "parameters": params,
}, [[20.0, "Slight rain"]])
run("unknown WMO codes preserve the weather row", {
    "root_entity": entity("forecast_current"),
    "dimensions": [member("forecast_current", "temperature_2m"), member("weather_codes", "description")],
    "parameters": {"latitude": 0, "longitude": 0},
}, [[20.0, None]])

run("hourly coverage is specific to each variable", {
    "measures": [member("forecast_hourly", field) for field in ["average_temperature", "temperature_hours_with_data", "total_precipitation", "precipitation_hours_with_data"]],
    "parameters": {"latitude": 52.52, "longitude": 13.41},
}, [[15.0, 2, 2.0, 1]], {"average_temperature": "Cel", "total_precipitation": "mm", "temperature_hours_with_data": "1", "precipitation_hours_with_data": "1"})

for name, coverage in [("forecast_hourly", "precipitation_hours_with_data"), ("forecast_daily", "precipitation_days_with_data")]:
    run(f"{name} all-missing precipitation is unknown, not zero", {
        "measures": [member(name, "total_precipitation"), member(name, coverage)],
        "parameters": {"latitude": -1, "longitude": 0},
    }, [[None, 0]])

run("snowfall depth and water-equivalent precipitation remain separate", {
    "measures": [member("forecast_daily", "total_snowfall"), member("forecast_daily", "total_precipitation")],
    "parameters": params,
}, [[3.0, 24.0]], {"total_snowfall": "cm", "total_precipitation": "mm"})
imperial = execute_semantic_query({"weather": catalog}, con.cursor(), {
    "measures": [member("forecast_daily", "total_snowfall"), member("forecast_daily", "total_precipitation")],
    "parameters": {**params, "precipitation_unit": "inch"},
})
assert imperial["ok"], imperial
assert all(math.isclose(actual, expected) for actual, expected in zip(imperial["result"]["rows"][0], [3 / 2.54, 24 / 25.4]))
assert imperial["plan"]["output_units"] == {"total_snowfall": "[in_i]", "total_precipitation": "[in_i]"}
print("PASS snowfall and precipitation convert to inches from different metric units")
run("air quality uses peak AQI rather than averaging index values", {
    "measures": [member("air_quality_hourly", "maximum_us_aqi"), member("air_quality_hourly", "maximum_european_aqi"), member("air_quality_hourly", "average_pm2_5")],
    "parameters": params,
}, [[120, 75, 20.0]])

run("forecast dew point and probability retain their independent units", {
    "root_entity": entity("forecast_hourly"),
    "dimensions": [member("forecast_hourly", field) for field in ["dew_point_2m", "precipitation_probability"]],
    "parameters": {**params, "temperature_unit": "fahrenheit", "precipitation_unit": "inch"},
    "order": [{"member": "dew_point_2m", "direction": "asc"}], "limit": 1,
}, [[37.4, 20.0]], {"dew_point_2m": "[degF]", "precipitation_probability": "%"})
run("peak hourly probability and its coverage exclude missing values", {
    "measures": [member("forecast_hourly", "maximum_hourly_precipitation_probability"), member("forecast_hourly", "precipitation_probability_hours_with_data")],
    "parameters": params,
}, [[80.0, 2]], {"maximum_hourly_precipitation_probability": "%", "precipitation_probability_hours_with_data": "1"})

run("explicit forecast model reaches the API and response provenance is selectable", {
    "root_entity": entity("forecast_current"),
    "dimensions": [member("forecast_current", field) for field in ["temperature_2m", "model_selection", "grid_latitude", "grid_longitude", "location_elevation", "retrieved_at", "source_endpoint"]],
    "parameters": {**params, "model": "gfs_global"},
}, [[18.0, "gfs_global", 35.7, 139.68, 40.0, "2024-01-08T00:00:00+00:00", "https://api.open-meteo.com/v1/forecast"]])
run("explicit historical model reaches the API", {
    "dimensions": [member("historical_daily", "model_selection")],
    "measures": [member("historical_daily", "highest_temperature")],
    "parameters": {**params, "model": "era5", "start_date": "2024-01-01", "end_date": "2024-01-07"},
}, [["era5", 26.0]])
for invalid in ["", "gfs_global,ecmwf_ifs025"]:
    rejected = execute_semantic_query({"weather": catalog}, con.cursor(), {
        "root_entity": entity("forecast_hourly"),
        "dimensions": [member("forecast_hourly", "temperature_2m")],
        "parameters": {**params, "model": invalid},
    })
    assert not rejected["ok"], rejected
print("PASS model lists and empty selectors fail instead of producing silent NULL fields")

run("hourly accumulation windows end at valid time", {
    "root_entity": entity("forecast_hourly"),
    "dimensions": [member("forecast_hourly", field) for field in ["time", "interval_start", "interval_end", "interval_seconds"]],
    "parameters": params, "order": [{"member": "time", "direction": "asc"}], "limit": 1,
}, [["2024-01-01T00:00:00+00:00", "2023-12-31T23:00:00+00:00", "2024-01-01T00:00:00+00:00", 3600]])
run("provider daily windows and response timezone are explicit", {
    "root_entity": entity("forecast_daily"),
    "dimensions": [member("forecast_daily", field) for field in ["date", "interval_start", "interval_end", "interval_seconds", "response_timezone", "utc_offset_seconds"]],
    "parameters": params, "order": [{"member": "date", "direction": "asc"}], "limit": 1,
}, [["2024-01-01", "2023-12-31T15:00:00+00:00", "2024-01-01T15:00:00+00:00", 86400, "Asia/Tokyo", 32400]])
run("current accumulation windows use the actual provider duration", {
    "root_entity": entity("forecast_current"),
    "dimensions": [member("forecast_current", field) for field in ["interval_start", "interval_end", "interval_seconds"]],
    "parameters": {"latitude": 1, "longitude": 0},
}, [["2023-12-31T23:30:00+00:00", "2024-01-01T00:00:00+00:00", 1800]])
run("missing provider metadata and current bounds remain unknown", {
    "root_entity": entity("forecast_current"),
    "dimensions": [member("forecast_current", field) for field in ["latitude", "grid_latitude", "location_elevation", "response_timezone", "interval_start", "interval_seconds"]],
    "parameters": {"latitude": -2, "longitude": 0},
}, [[-2.0, None, None, None, None, None]])

temporal, provenance = con.execute("""
    SELECT tags['open_meteo.temporal'], tags['open_meteo.provenance']
    FROM duckdb_functions() WHERE database_name = 'weather' AND function_name = 'forecast_hourly'
""").fetchone()
temporal, provenance = json.loads(temporal), json.loads(provenance)
assert temporal["members"]["precipitation_probability"]["statistic"] == "probability"
assert temporal["members"]["temperature_2m"]["support"] == "instant"
assert provenance["model_run_time"] == "not_supplied"
assert provenance["forecast_lead_time"] == "not_derivable"
print("PASS structured reporting support and provenance limits are discoverable")

multi = {
    "measures": [member("forecast_daily", "total_precipitation")],
    "inputs": [{"input_id": "cities", "grain": ["city"],
                "columns": [{"name": "city", "type": "VARCHAR"}, {"name": "lat", "type": "DOUBLE"}, {"name": "lon", "type": "DOUBLE"}],
                "rows": [["Berlin", 52.52, 13.41], ["Tokyo", 35.69, 139.69]]}],
    "source_bindings": [{"entity": entity("forecast_daily"), "driver": {"input_id": "cities"},
                         "arguments": {"latitude": {"input_column": "lat"}, "longitude": {"input_column": "lon"}}}],
}
result = execute_semantic_query({"weather": catalog}, con.cursor(), multi)
assert result["ok"], result
assert sorted(map(list, result["result"]["rows"])) == [["Berlin", 12.0], ["Tokyo", 24.0]], result
print("PASS period totals retain each driving location")

run("historical daily totals use the same vocabulary", {
    "measures": [member("historical_daily", "total_precipitation")],
    "parameters": {"latitude": 52.52, "longitude": 13.41, "start_date": "2024-01-01", "end_date": "2024-01-07"},
}, [[12.0]])

run("place name feeds daily weather with readable conditions", {
    "root_entity": entity("forecast_daily"),
    "dimensions": [member("geocoding", "name"), member("forecast_daily", "date"), member("weather_codes", "description")],
    "measures": [member("forecast_daily", "highest_temperature")],
    "inputs": [{"input_id": "places", "grain": ["search"], "columns": [{"name": "search", "type": "VARCHAR"}], "rows": [["Tokyo"]]}],
    "source_bindings": [{"entity": entity("geocoding"), "driver": {"input_id": "places"}, "arguments": {"name": {"input_column": "search"}}},
                        {"entity": entity("forecast_daily"), "driver": {"entity": entity("geocoding"), "max_rows": 1},
                         "arguments": {"latitude": {"member": member("geocoding", "latitude")}, "longitude": {"member": member("geocoding", "longitude")}}}],
    "parameters": {"count": 1},
    "order": [{"member": "date", "direction": "asc"}], "limit": 1,
}, [["Tokyo", 2, "Tokyo", "2024-01-01", "Slight rain", 20.0]])

# Every physical output must work as a semantic selection, not just be present
# in discovery. Compare the compiler result with the actual table function.
for (_, name), definition in model.entities.items():
    if name in {"geocoding", "elevation", "weather_codes"}:
        continue
    fields = [m["member_id"] for m in definition.members.values() if m.get("column") and not m.get("hidden")]
    arguments = "35.69, 139.69"
    parameters = dict(params)
    if name.startswith("historical"):
        arguments += ", '2024-01-01', '2024-01-07'"
        parameters.update(start_date="2024-01-01", end_date="2024-01-07")
    physical = con.execute(f"SELECT {', '.join(fields)} FROM weather.main.{name}({arguments}) ORDER BY time LIMIT 1").fetchall()
    expected = [[normalized(cell) for cell in row] for row in physical]
    assert all(cell is not None for cell in expected[0]), (name, expected)
    run(f"every {name} output is selectable", {
        "root_entity": entity(name), "dimensions": [member(name, field) for field in fields],
        "parameters": parameters, "order": [{"member": "time", "direction": "asc"}], "limit": 1,
    }, expected)

# An existing modeled table is a source, not a JSON copy of the user's rows.
# Two distinct sites deliberately share coordinates and the same region.
con.execute("ATTACH ':memory:' AS locations")
con.execute("CREATE TABLE locations.main.points (site_id VARCHAR PRIMARY KEY, region VARCHAR, lat DOUBLE, lon DOUBLE)")
con.execute("INSERT INTO locations.main.points VALUES ('site-a', 'Europe', 52.52, 13.41), ('site-b', 'Europe', 52.52, 13.41), ('site-c', 'Asia', 35.69, 139.69), ('site-missing', 'Europe', NULL, 13.41)")
snapshot = take_snapshot(con)
for database in snapshot.databases:
    if database["database_name"] == "locations":
        database["tags"] = {"vgi.semantic_catalog": json.dumps({"catalog_id": "example.locations"})}
for table in snapshot.tables:
    if table["database_name"] == "locations" and table["table_name"] == "points":
        table["tags"] = {
            "vgi.semantic_entity": json.dumps({"entity_id": "points", "grain": ["site_id"]}),
            "vgi.semantic_members": json.dumps([
                {"member_id": "site_id", "column": "site_id", "kind": "identifier", "data_type": "VARCHAR"},
                {"member_id": "region", "column": "region", "kind": "dimension", "data_type": "VARCHAR"},
                {"member_id": "latitude", "column": "lat", "kind": "dimension", "data_type": "DOUBLE"},
                {"member_id": "longitude", "column": "lon", "kind": "dimension", "data_type": "DOUBLE"},
            ]),
        }
locations_catalog = build_catalog(snapshot, "locations", "local://points")
assert not schema_diagnostics(locations_catalog), schema_diagnostics(locations_catalog)
assert not build_semantic_model(locations_catalog).diagnostics
points = {"catalog_id": "example.locations", "entity_id": "points"}
run("existing points table preserves site IDs and regions, including shared coordinates", {
    "dimensions": [{**points, "member_id": "region"}],
    "measures": [member("forecast_daily", "total_precipitation")],
    "source_bindings": [{"entity": entity("forecast_daily"), "driver": {"entity": points, "max_rows": 4},
                         "arguments": {"latitude": {"member": {**points, "member_id": "latitude"}},
                                       "longitude": {"member": {**points, "member_id": "longitude"}}}}],
    "parameters": {"forecast_days": 7}, "order": [{"member": "site_id", "direction": "asc"}],
}, [["site-a", "Europe", 12.0], ["site-b", "Europe", 12.0], ["site-c", "Asia", 24.0]],
    catalogs={"weather": catalog, "locations": locations_catalog})

# Semantic source bindings use CROSS JOIN LATERAL and omit null coordinates.
# SQL LEFT JOIN LATERAL provides retain-all behavior when users need it.
retained = con.execute("""
    SELECT p.site_id, sum(w.precipitation_sum)
    FROM locations.main.points AS p
    LEFT JOIN LATERAL weather.main.forecast_daily(p.lat, p.lon, forecast_days := 7) AS w ON true
    GROUP BY p.site_id ORDER BY p.site_id
""").fetchall()
assert retained == [("site-a", 12.0), ("site-b", 12.0), ("site-c", 24.0), ("site-missing", None)], retained
print("PASS SQL left lateral join retains sites with missing coordinates")
con.close()
print("All semantic acceptance checks passed.")
