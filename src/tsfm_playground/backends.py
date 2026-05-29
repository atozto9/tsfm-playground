"""Forecast backend registry and runtime model manager."""

from __future__ import annotations

import importlib
import math
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from .config import BackendSettings, ModelEntry, Settings
from .forecast import Timer, build_input_echo, series_id
from .schemas import (
    BackendCapabilities,
    ForecastRequest,
    ForecastResponse,
    ForecastSeriesOut,
    InfoResponse,
    ModelInfo,
    TimeSeriesIn,
)


class BackendLoadError(RuntimeError):
    """Raised when a backend cannot be imported or loaded."""


class ForecastBackend(Protocol):
    name: str
    source_ref: str | None
    capabilities: BackendCapabilities

    def load(self, cfg: BackendSettings) -> None:
        raise NotImplementedError

    def forecast(self, req: ForecastRequest) -> ForecastResponse:
        raise NotImplementedError

    def info_extra(self) -> dict[str, Any]:
        return {}


def _quantile_key(value: float) -> str:
    return f"{value:g}"


def _ensure_library_path(path: str | None) -> None:
    if not path:
        return
    resolved = Path(path).expanduser().resolve()
    if not resolved.exists():
        raise BackendLoadError(f"library_path does not exist: {resolved}")
    path_text = str(resolved)
    if path_text not in sys.path:
        sys.path.insert(0, path_text)


def _import_symbol(spec: str) -> type:
    if ":" not in spec:
        raise BackendLoadError("adapter_class must use 'module:ClassName' format.")
    module_name, symbol_name = spec.split(":", 1)
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:
        raise BackendLoadError(f"Could not import adapter module {module_name!r}: {exc}") from exc
    try:
        symbol = getattr(module, symbol_name)
    except AttributeError as exc:
        raise BackendLoadError(
            f"Adapter class {symbol_name!r} not found in {module_name!r}."
        ) from exc
    if not isinstance(symbol, type):
        raise BackendLoadError(f"Adapter symbol {spec!r} is not a class.")
    return symbol


def _source_ref(cfg: BackendSettings) -> str | None:
    return cfg.model_path or cfg.model_id


def _looks_remote_source(source: str | None) -> bool:
    if not source:
        return False
    expanded = Path(source).expanduser()
    if expanded.exists():
        return False
    if source.startswith(("/", "./", "../", "~")):
        return False
    return "/" in source or source.startswith("hf://")


def _guard_remote_source(cfg: BackendSettings) -> None:
    source = _source_ref(cfg)
    if _looks_remote_source(source) and not cfg.allow_remote_download:
        raise BackendLoadError(
            f"{cfg.name} source {source!r} looks remote. Set allow_remote_download=true "
            "to permit adapter-initiated downloads."
        )


def _coerce_response(raw: Any) -> ForecastResponse:
    if isinstance(raw, ForecastResponse):
        return raw
    if isinstance(raw, dict):
        return ForecastResponse.model_validate(raw)
    raise TypeError("backend forecast() must return ForecastResponse or a compatible dict.")


class FakeForecastBackend:
    """Small deterministic backend used by tests and default local development."""

    name = "fake"
    source_ref = "fake://linear-trend"
    capabilities = BackendCapabilities(
        multivariate=True,
        covariates=False,
        quantiles=True,
        local_library_path=False,
        remote_download=False,
    )

    def load(self, _cfg: BackendSettings) -> None:
        return

    def info_extra(self) -> dict[str, Any]:
        return {"mode": "deterministic linear continuation"}

    def forecast(self, req: ForecastRequest) -> ForecastResponse:
        prep = Timer()
        input_echo = build_input_echo(req)
        prep_time_s = prep.elapsed()
        forecast_timer = Timer()
        forecasts: list[ForecastSeriesOut] = []
        for index, series in enumerate(req.series):
            values = list(series.values)
            diffs = [values[i] - values[i - 1] for i in range(1, len(values))]
            slope = float(np.mean(diffs[-min(8, len(diffs)):])) if diffs else 0.0
            last = values[-1]
            point = [last + slope * (step + 1) for step in range(req.horizon)]
            residuals = [diff - slope for diff in diffs] or [0.0]
            scale = float(np.std(residuals)) or max(abs(last), 1.0) * 0.02
            quantiles: dict[str, list[float]] = {}
            for quantile in req.quantiles:
                if math.isclose(quantile, 0.5):
                    quantiles[_quantile_key(quantile)] = list(point)
                    continue
                offset = (quantile - 0.5) * 2.0
                quantiles[_quantile_key(quantile)] = [
                    value + offset * scale * math.sqrt(step + 1)
                    for step, value in enumerate(point)
                ]
            forecasts.append(
                ForecastSeriesOut(
                    id=series_id(series, index),
                    name=series.name,
                    point=point,
                    quantiles=quantiles,
                    timestamps=None,
                )
            )

        return ForecastResponse(
            forecasts=forecasts,
            input_echo=input_echo,
            backend=self.name,
            model_id=req.model_id,
            prep_time_s=prep_time_s,
            forecast_time_s=forecast_timer.elapsed(),
            context=req.context,
            raw={"mode": "fake"},
        )


class Chronos2ForecastBackend:
    name = "chronos2"
    capabilities = BackendCapabilities(
        multivariate=True,
        covariates=True,
        quantiles=True,
        local_library_path=True,
        remote_download=False,
    )

    def __init__(self) -> None:
        self.source_ref: str | None = None
        self._pipeline: Any = None
        self._cfg: BackendSettings | None = None

    def load(self, cfg: BackendSettings) -> None:
        _ensure_library_path(cfg.library_path)
        _guard_remote_source(cfg)
        source = _source_ref(cfg)
        if not source:
            raise BackendLoadError("chronos2 backend requires model_path or model_id.")
        try:
            from chronos import Chronos2Pipeline
        except ImportError as exc:
            raise BackendLoadError(
                "Could not import Chronos2Pipeline. Provide library_path for a local "
                "chronos-forecasting checkout or install it in the environment."
            ) from exc
        kwargs = dict(cfg.backend_options)
        if cfg.device and "device_map" not in kwargs:
            kwargs["device_map"] = cfg.device
        self._pipeline = Chronos2Pipeline.from_pretrained(source, **kwargs)
        self.source_ref = source
        self._cfg = cfg

    def info_extra(self) -> dict[str, Any]:
        return {"adapter": "Chronos2Pipeline.predict_df"}

    def forecast(self, req: ForecastRequest) -> ForecastResponse:
        if self._pipeline is None:
            raise RuntimeError("chronos2 backend is not loaded.")
        prep = Timer()
        input_echo = build_input_echo(req)
        context_df, future_df = _request_to_dataframe(req)
        prep_time_s = prep.elapsed()
        timer = Timer()
        pred_df = self._pipeline.predict_df(
            context_df,
            future_df=future_df,
            prediction_length=req.horizon,
            quantile_levels=req.quantiles,
            id_column="id",
            timestamp_column="timestamp",
            target=req.target,
        )
        forecasts = _forecast_series_from_dataframe(pred_df, req)
        return ForecastResponse(
            forecasts=forecasts,
            input_echo=input_echo,
            backend=self.name,
            model_id=req.model_id,
            prep_time_s=prep_time_s,
            forecast_time_s=timer.elapsed(),
            context=req.context,
            raw={"columns": list(getattr(pred_df, "columns", []))},
        )


def _request_to_dataframe(req: ForecastRequest):
    try:
        import pandas as pd
    except ImportError as exc:
        raise BackendLoadError("Chronos-2 dataframe adapter requires pandas.") from exc

    context_rows: list[dict[str, Any]] = []
    future_rows_by_series: dict[str, dict[int, dict[str, Any]]] = {}
    series_by_id: dict[str, TimeSeriesIn] = {}
    for series_index, series in enumerate(req.series):
        sid = series_id(series, series_index)
        series_by_id[sid] = series
        for value_index, value in enumerate(series.values):
            timestamp = (
                series.timestamps[value_index]
                if series.timestamps is not None
                else pd.Timestamp("2000-01-01") + pd.Timedelta(days=value_index)
            )
            context_rows.append(
                {"id": sid, "timestamp": timestamp, req.target: value, "_position": value_index}
            )

    for covariate in req.covariates:
        target_ids = (
            [covariate.series_id]
            if covariate.series_id is not None
            else [series_id(series, index) for index, series in enumerate(req.series)]
        )
        if covariate.alignment == "past":
            for row in context_rows:
                if row["id"] in target_ids:
                    series = series_by_id[row["id"]]
                    pos = min(row["_position"], len(series.values) - 1, len(covariate.values) - 1)
                    row[covariate.name] = covariate.values[pos]
        else:
            for sid in target_ids:
                series = series_by_id[sid]
                for step, value in enumerate(covariate.values):
                    timestamp = (
                        covariate.timestamps[step]
                        if covariate.timestamps is not None
                        else pd.Timestamp("2000-01-01")
                        + pd.Timedelta(days=len(series.values) + step)
                    )
                    future_rows_by_series.setdefault(sid, {}).setdefault(
                        step,
                        {"id": sid, "timestamp": timestamp},
                    )
                    future_rows_by_series[sid][step][covariate.name] = value

    for row in context_rows:
        row.pop("_position", None)
    future_rows = [
        row
        for step_rows in future_rows_by_series.values()
        for _step, row in sorted(step_rows.items())
    ]
    return pd.DataFrame(context_rows), pd.DataFrame(future_rows) if future_rows else None


def _find_column(columns: list[Any], value: float) -> Any | None:
    candidates = {value, str(value), f"{value:g}", f"q{value:g}", f"quantile_{value:g}"}
    for column in columns:
        if column in candidates or str(column) in candidates:
            return column
    return None


def _forecast_series_from_dataframe(pred_df: Any, req: ForecastRequest) -> list[ForecastSeriesOut]:
    columns = list(pred_df.columns)
    if "predictions" in columns:
        point_column = "predictions"
    elif "mean" in columns:
        point_column = "mean"
    else:
        point_column = _find_column(columns, 0.5) or _find_column(
            columns,
            min(req.quantiles, key=lambda value: abs(value - 0.5)),
        )
    out: list[ForecastSeriesOut] = []
    for index, series in enumerate(req.series):
        sid = series_id(series, index)
        rows = pred_df[pred_df["id"] == sid].head(req.horizon)
        point = [float(value) for value in rows[point_column].tolist()] if point_column else []
        quantiles: dict[str, list[float]] = {}
        for quantile in req.quantiles:
            column = _find_column(columns, quantile)
            if column is not None:
                quantiles[_quantile_key(quantile)] = [
                    float(value) for value in rows[column].tolist()
                ]
        out.append(
            ForecastSeriesOut(
                id=sid,
                name=series.name,
                point=point,
                quantiles=quantiles,
                timestamps=[str(value) for value in rows["timestamp"].tolist()]
                if series.timestamps is not None and "timestamp" in columns
                else None,
            )
        )
    return out


class TimesFMForecastBackend:
    name = "timesfm"
    capabilities = BackendCapabilities(
        multivariate=False,
        covariates=False,
        quantiles=True,
        local_library_path=True,
        remote_download=False,
    )

    def __init__(self) -> None:
        self.source_ref: str | None = None
        self._model: Any = None
        self._timesfm: Any = None

    def load(self, cfg: BackendSettings) -> None:
        _ensure_library_path(cfg.library_path)
        _guard_remote_source(cfg)
        source = _source_ref(cfg)
        if not source:
            raise BackendLoadError("timesfm backend requires model_path or model_id.")
        try:
            timesfm = importlib.import_module("timesfm")
        except ImportError as exc:
            raise BackendLoadError(
                "Could not import timesfm. Provide library_path for a local TimesFM checkout "
                "or install it in the environment."
            ) from exc
        class_name = str(cfg.backend_options.get("class_name", "TimesFM_2p5_200M_torch"))
        model_cls = getattr(timesfm, class_name, None)
        if model_cls is None:
            raise BackendLoadError(f"timesfm class {class_name!r} was not found.")
        self._model = model_cls.from_pretrained(source)
        forecast_config = cfg.backend_options.get("forecast_config")
        if forecast_config and hasattr(self._model, "compile"):
            config_cls = getattr(timesfm, "ForecastConfig", None)
            self._model.compile(config_cls(**forecast_config) if config_cls else forecast_config)
        self._timesfm = timesfm
        self.source_ref = source

    def info_extra(self) -> dict[str, Any]:
        return {"adapter": "TimesFM forecast"}

    def forecast(self, req: ForecastRequest) -> ForecastResponse:
        if self._model is None:
            raise RuntimeError("timesfm backend is not loaded.")
        prep = Timer()
        input_echo = build_input_echo(req)
        inputs = [np.asarray(series.values, dtype=float) for series in req.series]
        prep_time_s = prep.elapsed()
        timer = Timer()
        raw = self._model.forecast(inputs=inputs, horizon=req.horizon)
        point_raw, quantile_raw = raw if isinstance(raw, tuple) else (raw, None)
        forecasts = _forecast_series_from_arrays(point_raw, quantile_raw, req)
        return ForecastResponse(
            forecasts=forecasts,
            input_echo=input_echo,
            backend=self.name,
            model_id=req.model_id,
            prep_time_s=prep_time_s,
            forecast_time_s=timer.elapsed(),
            context=req.context,
            raw={"adapter": "timesfm"},
        )


def _forecast_series_from_arrays(
    point_raw: Any,
    quantile_raw: Any,
    req: ForecastRequest,
) -> list[ForecastSeriesOut]:
    points = np.asarray(point_raw, dtype=float)
    quantiles_arr = None if quantile_raw is None else np.asarray(quantile_raw, dtype=float)
    out: list[ForecastSeriesOut] = []
    for index, series in enumerate(req.series):
        sid = series_id(series, index)
        point = (
            points[index, : req.horizon].tolist()
            if points.ndim > 1
            else points[: req.horizon].tolist()
        )
        quantiles: dict[str, list[float]] = {}
        if quantiles_arr is not None and quantiles_arr.ndim >= 3:
            available = [
                round(value, 1)
                for value in np.linspace(0.1, 0.9, quantiles_arr.shape[-1])
            ]
            for quantile in req.quantiles:
                q_index = min(range(len(available)), key=lambda pos: abs(available[pos] - quantile))
                quantiles[_quantile_key(quantile)] = quantiles_arr[
                    index,
                    : req.horizon,
                    q_index,
                ].tolist()
        out.append(ForecastSeriesOut(id=sid, name=series.name, point=point, quantiles=quantiles))
    return out


class CustomForecastBackend:
    name = "custom"
    capabilities = BackendCapabilities(
        multivariate=True,
        covariates=True,
        quantiles=True,
        local_library_path=True,
        remote_download=False,
    )

    def __init__(self) -> None:
        self.source_ref: str | None = None
        self._adapter: Any = None

    def load(self, cfg: BackendSettings) -> None:
        _ensure_library_path(cfg.library_path)
        if not cfg.adapter_class:
            raise BackendLoadError("custom backend requires adapter_class.")
        adapter_cls = _import_symbol(cfg.adapter_class)
        self._adapter = adapter_cls()
        if hasattr(self._adapter, "load"):
            self._adapter.load(cfg)
        self.source_ref = _source_ref(cfg) or cfg.adapter_class
        capabilities = getattr(self._adapter, "capabilities", None)
        if capabilities is not None:
            self.capabilities = BackendCapabilities.model_validate(capabilities)

    def info_extra(self) -> dict[str, Any]:
        if self._adapter is not None and hasattr(self._adapter, "info"):
            info = self._adapter.info()
            return dict(info) if isinstance(info, dict) else {"info": info}
        return {"adapter": "custom"}

    def forecast(self, req: ForecastRequest) -> ForecastResponse:
        if self._adapter is None:
            raise RuntimeError("custom backend is not loaded.")
        return _coerce_response(self._adapter.forecast(req))


BACKENDS: dict[str, type] = {
    "fake": FakeForecastBackend,
    "chronos2": Chronos2ForecastBackend,
    "timesfm": TimesFMForecastBackend,
    "custom": CustomForecastBackend,
}


def load_backend_from_settings(cfg: BackendSettings) -> ForecastBackend:
    if cfg.adapter_class and cfg.name not in BACKENDS:
        backend: ForecastBackend = CustomForecastBackend()
    else:
        backend_cls = BACKENDS.get(cfg.name)
        if backend_cls is None:
            raise BackendLoadError(f"Unknown backend {cfg.name!r}. Available: {sorted(BACKENDS)}")
        backend = backend_cls()
    backend.load(cfg)
    return backend


def _capabilities_for_entry(entry: ModelEntry) -> BackendCapabilities:
    backend_cls = BACKENDS.get(entry.backend)
    capabilities = getattr(backend_cls, "capabilities", None)
    if capabilities is None:
        return BackendCapabilities()
    return BackendCapabilities.model_validate(capabilities)


@dataclass
class ModelSlot:
    entry: ModelEntry
    backend: ForecastBackend | None = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    load_error: str | None = None

    @property
    def loaded(self) -> bool:
        return self.backend is not None


class ModelManager:
    def __init__(self, entries: list[ModelEntry]) -> None:
        if not entries:
            raise ValueError("at least one model entry is required.")
        self._slots = {entry.id: ModelSlot(entry=entry) for entry in entries}
        self.default_model_id = entries[0].id

    @classmethod
    def from_settings(cls, settings: Settings) -> ModelManager:
        if settings.models:
            entries = settings.models
        else:
            entries = [
                ModelEntry(
                    id="default",
                    label=settings.backend.name,
                    backend=settings.backend.name,
                    model_path=settings.backend.model_path,
                    model_id=settings.backend.model_id,
                    library_path=settings.backend.library_path,
                    adapter_class=settings.backend.adapter_class,
                    device=settings.backend.device,
                    allow_remote_download=settings.backend.allow_remote_download,
                    backend_options=dict(settings.backend.backend_options),
                    preload=True,
                )
            ]
        return cls(entries)

    def load_initial(self) -> None:
        for model_id, slot in self._slots.items():
            if slot.entry.preload:
                self.ensure_loaded(model_id)

    def ensure_loaded(self, model_id: str) -> ForecastBackend:
        slot = self._slot(model_id)
        with slot.lock:
            if slot.backend is not None:
                return slot.backend
            try:
                slot.backend = load_backend_from_settings(slot.entry.to_backend_settings())
                slot.load_error = None
            except Exception as exc:
                slot.load_error = str(exc)
                raise
            return slot.backend

    def forecast(self, model_id: str, req: ForecastRequest) -> ForecastResponse:
        slot = self._slot(model_id)
        with slot.lock:
            backend = self.ensure_loaded(model_id)
            response = backend.forecast(req)
            if response.context is None:
                response = response.model_copy(update={"context": req.context})
            return response

    def list_models(self, active_model_id: str) -> list[ModelInfo]:
        return [
            ModelInfo(
                id=model_id,
                label=slot.entry.label,
                backend=slot.entry.backend,
                active=model_id == active_model_id,
                loaded=slot.loaded,
                source_ref=(
                    slot.backend.source_ref
                    if slot.backend is not None
                    else slot.entry.model_path or slot.entry.model_id
                ),
            )
            for model_id, slot in self._slots.items()
        ]

    def switch_model(self, model_id: str) -> ModelEntry:
        self.ensure_loaded(model_id)
        return self._slot(model_id).entry

    def info(self, model_id: str, defaults: dict[str, Any]) -> InfoResponse:
        slot = self._slot(model_id)
        backend = slot.backend
        if backend is not None:
            return InfoResponse(
                backend=backend.name,
                model_id=model_id,
                source_ref=backend.source_ref,
                loaded=True,
                capabilities=backend.capabilities,
                defaults=defaults,
                extra=backend.info_extra(),
            )
        return InfoResponse(
            backend=slot.entry.backend,
            model_id=model_id,
            source_ref=slot.entry.model_path or slot.entry.model_id,
            loaded=False,
            capabilities=_capabilities_for_entry(slot.entry),
            defaults=defaults,
            extra={"load_error": slot.load_error} if slot.load_error else {},
        )

    def _slot(self, model_id: str) -> ModelSlot:
        try:
            return self._slots[model_id]
        except KeyError as exc:
            raise KeyError(
                f"Unknown model_id {model_id!r}. Available: {sorted(self._slots)}"
            ) from exc
