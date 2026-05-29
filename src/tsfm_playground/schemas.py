"""Pydantic DTOs for request/response payloads."""

from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class TimeSeriesStats(BaseModel):
    length: int
    min: float | None = None
    max: float | None = None
    mean: float | None = None


class TimeSeriesIn(BaseModel):
    id: str | None = None
    name: str | None = None
    values: list[float] = Field(default_factory=list)
    timestamps: list[str] | None = None

    @field_validator("values")
    @classmethod
    def values_must_be_finite(cls, values: list[float]) -> list[float]:
        if not values:
            raise ValueError("time series values must not be empty.")
        if any(not math.isfinite(value) for value in values):
            raise ValueError("time series values must be finite numbers.")
        return values

    @model_validator(mode="after")
    def timestamps_must_match_values(self) -> TimeSeriesIn:
        if self.timestamps is not None and len(self.timestamps) != len(self.values):
            raise ValueError("timestamps length must match values length.")
        return self


class CovariateIn(BaseModel):
    name: str
    values: list[float] = Field(default_factory=list)
    series_id: str | None = None
    alignment: Literal["past", "future"] = "future"
    timestamps: list[str] | None = None

    @field_validator("values")
    @classmethod
    def values_must_be_finite(cls, values: list[float]) -> list[float]:
        if not values:
            raise ValueError("covariate values must not be empty.")
        if any(not math.isfinite(value) for value in values):
            raise ValueError("covariate values must be finite numbers.")
        return values

    @model_validator(mode="after")
    def timestamps_must_match_values(self) -> CovariateIn:
        if self.timestamps is not None and len(self.timestamps) != len(self.values):
            raise ValueError("covariate timestamps length must match values length.")
        return self


class ForecastContext(BaseModel):
    mode: Literal["full", "tail", "range"] = "full"
    start_index: int | None = Field(default=None, ge=0)
    end_index: int | None = Field(default=None, ge=0)
    original_lengths: dict[str, int] = Field(default_factory=dict)

    @field_validator("original_lengths")
    @classmethod
    def original_lengths_must_be_non_negative(cls, values: dict[str, int]) -> dict[str, int]:
        if any(value < 0 for value in values.values()):
            raise ValueError("original_lengths values must be non-negative.")
        return values

    @model_validator(mode="after")
    def range_bounds_must_be_valid(self) -> ForecastContext:
        if self.mode != "range":
            return self
        if self.start_index is None or self.end_index is None:
            raise ValueError("range context requires start_index and end_index.")
        if self.start_index >= self.end_index:
            raise ValueError("range context requires start_index < end_index.")
        return self


class ForecastRequest(BaseModel):
    series: list[TimeSeriesIn] = Field(default_factory=list)
    horizon: int = Field(gt=0, le=10000)
    quantiles: list[float] = Field(default_factory=lambda: [0.1, 0.5, 0.9])
    target: str = "value"
    covariates: list[CovariateIn] = Field(default_factory=list)
    model_options: dict[str, Any] = Field(default_factory=dict)
    model_id: str | None = None
    context: ForecastContext = Field(default_factory=ForecastContext)

    @field_validator("series")
    @classmethod
    def series_must_not_be_empty(cls, series: list[TimeSeriesIn]) -> list[TimeSeriesIn]:
        if not series:
            raise ValueError("at least one time series is required.")
        return series

    @field_validator("quantiles")
    @classmethod
    def quantiles_must_be_valid(cls, values: list[float]) -> list[float]:
        if not values:
            raise ValueError("quantiles must not be empty.")
        seen: set[float] = set()
        for value in values:
            if value <= 0 or value >= 1:
                raise ValueError("quantiles must be between 0 and 1.")
            if value in seen:
                raise ValueError("quantiles must not contain duplicates.")
            seen.add(value)
        return sorted(values)

    @model_validator(mode="after")
    def future_covariates_must_match_horizon(self) -> ForecastRequest:
        for covariate in self.covariates:
            if covariate.alignment == "future" and len(covariate.values) != self.horizon:
                raise ValueError(
                    f"future covariate {covariate.name!r} length must match horizon."
                )
        if (
            self.context.mode == "range"
            and self.context.start_index is not None
            and self.context.end_index is not None
        ):
            expected_length = self.context.end_index - self.context.start_index
            for series in self.series:
                if len(series.values) != expected_length:
                    name = series.name or series.id or "<unnamed>"
                    raise ValueError(
                        f"range context length for {name!r} must equal end_index - start_index."
                    )
        return self


class ForecastSeriesOut(BaseModel):
    id: str
    name: str | None = None
    point: list[float]
    quantiles: dict[str, list[float]] = Field(default_factory=dict)
    timestamps: list[str] | None = None


class TimeSeriesEcho(BaseModel):
    id: str
    name: str | None = None
    values: list[float]
    timestamps: list[str] | None = None
    stats: TimeSeriesStats


class ForecastResponse(BaseModel):
    forecasts: list[ForecastSeriesOut]
    input_echo: list[TimeSeriesEcho]
    backend: str
    model_id: str | None = None
    prep_time_s: float
    forecast_time_s: float
    context: ForecastContext | None = None
    raw: dict[str, Any] | None = None


class BackendCapabilities(BaseModel):
    multivariate: bool = False
    covariates: bool = False
    quantiles: bool = True
    local_library_path: bool = True
    remote_download: bool = False


class InfoResponse(BaseModel):
    backend: str
    model_id: str | None = None
    source_ref: str | None = None
    loaded: bool = True
    capabilities: BackendCapabilities = Field(default_factory=BackendCapabilities)
    defaults: dict[str, Any] = Field(default_factory=dict)
    extra: dict[str, Any] = Field(default_factory=dict)


class ParsedSeries(BaseModel):
    name: str
    values: list[float]
    timestamps: list[str] | None = None


class ParseFileResponse(BaseModel):
    series: list[ParsedSeries]


class HealthResponse(BaseModel):
    status: str = "ok"


class ModelInfo(BaseModel):
    id: str
    label: str
    backend: str
    active: bool
    loaded: bool = False
    source_ref: str | None = None


class ModelsResponse(BaseModel):
    models: list[ModelInfo]


class SwitchRequest(BaseModel):
    model_id: str


class SwitchResponse(BaseModel):
    model_id: str
    label: str
    backend: str
