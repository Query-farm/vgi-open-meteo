"""Input validation for the three bounded Open-Meteo analyses."""

from datetime import UTC, datetime
import math
import re

PALETTE = ["#247C6D", "#BC5738"]


def sql_text(value):
    return "'" + value.replace("'", "''") + "'"


def number(value, decimals=1):
    return (
        f"{value:.{decimals}f}"
        if value is not None and math.isfinite(value)
        else "unavailable"
    )


def weather_window(places, days, boundary, model):
    if (
        not isinstance(places, list)
        or len(places) != 2
        or any(not isinstance(p, str) or not 2 <= len(p.strip()) <= 60 for p in places)
        or len({p.casefold().strip() for p in places}) != 2
    ):
        raise ValueError("PLACES needs two distinct names of 2–60 characters")
    if type(days) is not int or not 1 <= days <= 5:
        raise ValueError("FORECAST_DAYS must be an integer from 1 to 5")
    if boundary not in {"auto", "GMT"}:
        raise ValueError("DAY_BOUNDARY must be auto or GMT")
    if not isinstance(model, str) or not re.fullmatch(r"[a-z0-9_]{1,60}", model):
        raise ValueError("MODEL must be a single provider model selector")
    return (
        ", ".join(f"({sql_text(p)})" for p in places),
        sql_text(boundary),
        sql_text(model),
        datetime.now(UTC),
    )


def finite_limit(value, name, maximum):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"{name} must be a finite number")
    if not 0 <= value <= maximum:
        raise ValueError(f"{name} must lie between 0 and {maximum}")
    return datetime.now(UTC)
