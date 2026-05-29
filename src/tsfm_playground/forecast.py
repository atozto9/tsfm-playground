"""Forecast request preparation helpers."""

from __future__ import annotations

import statistics
import time

from .schemas import ForecastRequest, TimeSeriesEcho, TimeSeriesIn, TimeSeriesStats


def stats_for(values: list[float]) -> TimeSeriesStats:
    return TimeSeriesStats(
        length=len(values),
        min=min(values) if values else None,
        max=max(values) if values else None,
        mean=statistics.fmean(values) if values else None,
    )


def series_id(series: TimeSeriesIn, index: int) -> str:
    return series.id or f"series_{index}"


def build_input_echo(req: ForecastRequest) -> list[TimeSeriesEcho]:
    return [
        TimeSeriesEcho(
            id=series_id(series, index),
            name=series.name,
            values=list(series.values),
            timestamps=list(series.timestamps) if series.timestamps is not None else None,
            stats=stats_for(list(series.values)),
        )
        for index, series in enumerate(req.series)
    ]


class Timer:
    def __init__(self) -> None:
        self.started_at = time.perf_counter()

    def elapsed(self) -> float:
        return time.perf_counter() - self.started_at
