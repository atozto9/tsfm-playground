"""Playground server settings + CLI parser.

Priority, later wins:
1. built-in defaults
2. YAML config file
3. CLI flags
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "configs" / "default.yaml"


@dataclass
class ServerSettings:
    host: str = "0.0.0.0"
    port: int = 7860


@dataclass
class BackendSettings:
    name: str = "fake"
    model_path: str | None = None
    model_id: str | None = None
    library_path: str | None = None
    adapter_class: str | None = None
    device: str | None = None
    allow_remote_download: bool = False
    backend_options: dict[str, Any] = field(default_factory=dict)


@dataclass
class ForecastSettings:
    horizon: int = 24
    quantiles: list[float] = field(default_factory=lambda: [0.1, 0.5, 0.9])
    max_horizon: int = 10000


@dataclass
class ServingSettings:
    session_timeout_s: float = 1800.0


@dataclass
class UiSettings:
    initial_demo: str = "wave"


@dataclass
class ModelEntry:
    id: str
    label: str
    backend: str
    model_path: str | None = None
    model_id: str | None = None
    library_path: str | None = None
    adapter_class: str | None = None
    device: str | None = None
    allow_remote_download: bool = False
    backend_options: dict[str, Any] = field(default_factory=dict)
    preload: bool = True

    def to_backend_settings(self) -> BackendSettings:
        return BackendSettings(
            name=self.backend,
            model_path=self.model_path,
            model_id=self.model_id,
            library_path=self.library_path,
            adapter_class=self.adapter_class,
            device=self.device,
            allow_remote_download=self.allow_remote_download,
            backend_options=dict(self.backend_options),
        )


@dataclass
class Settings:
    server: ServerSettings = field(default_factory=ServerSettings)
    backend: BackendSettings = field(default_factory=BackendSettings)
    forecast: ForecastSettings = field(default_factory=ForecastSettings)
    serving: ServingSettings = field(default_factory=ServingSettings)
    ui: UiSettings = field(default_factory=UiSettings)
    models: list[ModelEntry] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"Config YAML must be a mapping: {path}")
    return raw


def _merge_section(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if value is not None:
            merged[key] = value
    return merged


def _coerce_backend_options(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return dict(raw)
    raise ValueError("backend_options must be a mapping.")


def _coerce_backend(raw: Any) -> BackendSettings:
    if raw is None:
        return BackendSettings()
    if isinstance(raw, BackendSettings):
        return raw
    if not isinstance(raw, dict):
        raise ValueError("backend config must be a mapping.")
    merged = _merge_section(asdict(BackendSettings()), dict(raw))
    merged["backend_options"] = _coerce_backend_options(merged.get("backend_options"))
    return BackendSettings(**merged)


def _coerce_forecast(raw: Any) -> ForecastSettings:
    if raw is None:
        return ForecastSettings()
    if isinstance(raw, ForecastSettings):
        _validate_forecast_settings(raw)
        return raw
    if not isinstance(raw, dict):
        raise ValueError("forecast config must be a mapping.")
    merged = _merge_section(asdict(ForecastSettings()), dict(raw))
    cfg = ForecastSettings(**merged)
    _validate_forecast_settings(cfg)
    return cfg


def _coerce_server(raw: Any) -> ServerSettings:
    if raw is None:
        return ServerSettings()
    if not isinstance(raw, dict):
        raise ValueError("server config must be a mapping.")
    return ServerSettings(**_merge_section(asdict(ServerSettings()), dict(raw)))


def _coerce_serving(raw: Any) -> ServingSettings:
    if raw is None:
        return ServingSettings()
    if not isinstance(raw, dict):
        raise ValueError("serving config must be a mapping.")
    return ServingSettings(**_merge_section(asdict(ServingSettings()), dict(raw)))


def _coerce_ui(raw: Any) -> UiSettings:
    if raw is None:
        return UiSettings()
    if not isinstance(raw, dict):
        raise ValueError("ui config must be a mapping.")
    return UiSettings(**_merge_section(asdict(UiSettings()), dict(raw)))


def _coerce_model_entry(raw: Any) -> ModelEntry:
    if isinstance(raw, ModelEntry):
        return raw
    if not isinstance(raw, dict):
        raise ValueError("each model entry must be a mapping.")
    if "id" not in raw:
        raise ValueError("model entry requires 'id'.")
    if "backend" not in raw:
        raise ValueError(f"model entry {raw.get('id')!r} requires 'backend'.")
    values = {
        "id": str(raw["id"]),
        "label": str(raw.get("label") or raw["id"]),
        "backend": str(raw["backend"]),
        "model_path": raw.get("model_path"),
        "model_id": raw.get("model_id"),
        "library_path": raw.get("library_path"),
        "adapter_class": raw.get("adapter_class"),
        "device": raw.get("device"),
        "allow_remote_download": bool(raw.get("allow_remote_download", False)),
        "backend_options": _coerce_backend_options(raw.get("backend_options")),
        "preload": bool(raw.get("preload", True)),
    }
    return ModelEntry(**values)


def _coerce_models(raw: Any) -> list[ModelEntry]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("models config must be a list.")
    entries = [_coerce_model_entry(item) for item in raw]
    ids = [entry.id for entry in entries]
    if len(ids) != len(set(ids)):
        raise ValueError("model ids must be unique.")
    return entries


def _validate_quantiles(values: list[float]) -> None:
    if not values:
        raise ValueError("forecast.quantiles must not be empty.")
    seen: set[float] = set()
    for value in values:
        if value <= 0 or value >= 1:
            raise ValueError("forecast.quantiles must be between 0 and 1.")
        if value in seen:
            raise ValueError("forecast.quantiles must not contain duplicates.")
        seen.add(value)


def _validate_forecast_settings(cfg: ForecastSettings) -> None:
    if cfg.horizon <= 0:
        raise ValueError("forecast.horizon must be positive.")
    if cfg.max_horizon <= 0:
        raise ValueError("forecast.max_horizon must be positive.")
    if cfg.horizon > cfg.max_horizon:
        raise ValueError("forecast.horizon must be <= forecast.max_horizon.")
    _validate_quantiles(cfg.quantiles)


def build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tsfm-playground",
        description="Interactive time-series foundation model forecast playground.",
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument("--host", type=str, default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--backend", type=str, default=None)
    parser.add_argument("--model-path", type=str, default=None)
    parser.add_argument("--model-id", type=str, default=None)
    parser.add_argument("--library-path", type=str, default=None)
    parser.add_argument("--adapter-class", type=str, default=None)
    parser.add_argument("--device", type=str, default=None)
    parser.add_argument(
        "--allow-remote-download",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="Allow adapters to load remote model ids. Default is false.",
    )
    parser.add_argument("--horizon", type=int, default=None)
    parser.add_argument(
        "--quantiles",
        type=str,
        default=None,
        help="Comma-separated quantiles, for example: 0.1,0.5,0.9",
    )
    return parser


def _parse_quantiles(raw: str | None) -> list[float] | None:
    if raw is None:
        return None
    values = [float(part.strip()) for part in raw.split(",") if part.strip()]
    _validate_quantiles(values)
    return values


def settings_from_args(argv: list[str] | None = None) -> Settings:
    args = build_argparser().parse_args(argv)
    raw = _load_yaml(args.config)

    server = _coerce_server(raw.get("server"))
    backend = _coerce_backend(raw.get("backend"))
    forecast = _coerce_forecast(raw.get("forecast"))
    serving = _coerce_serving(raw.get("serving"))
    ui = _coerce_ui(raw.get("ui"))
    models = _coerce_models(raw.get("models"))

    server = ServerSettings(
        **_merge_section(asdict(server), {"host": args.host, "port": args.port})
    )
    backend_cli = {
        "name": args.backend,
        "model_path": args.model_path,
        "model_id": args.model_id,
        "library_path": args.library_path,
        "adapter_class": args.adapter_class,
        "device": args.device,
        "allow_remote_download": args.allow_remote_download,
    }
    backend = BackendSettings(**_merge_section(asdict(backend), backend_cli))
    forecast = ForecastSettings(
        **_merge_section(
            asdict(forecast),
            {"horizon": args.horizon, "quantiles": _parse_quantiles(args.quantiles)},
        )
    )
    _validate_forecast_settings(forecast)

    if any(value is not None for value in backend_cli.values()):
        models = []

    return Settings(
        server=server,
        backend=backend,
        forecast=forecast,
        serving=serving,
        ui=ui,
        models=models,
    )
