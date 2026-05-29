from __future__ import annotations

from pathlib import Path

import pytest

from tsfm_playground.config import settings_from_args


def test_settings_loads_local_library_path_for_model(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    lib = tmp_path / "lib"
    lib.mkdir()
    cfg.write_text(
        f"""
server:
  port: 9000
forecast:
  horizon: 12
  quantiles: [0.2, 0.5, 0.8]
models:
  - id: custom
    label: Custom
    backend: custom
    library_path: "{lib}"
    adapter_class: "pkg:Adapter"
    model_path: "/models/custom"
    preload: false
""",
        encoding="utf-8",
    )

    settings = settings_from_args(["--config", str(cfg)])

    assert settings.server.port == 9000
    assert settings.forecast.horizon == 12
    assert settings.forecast.quantiles == [0.2, 0.5, 0.8]
    assert settings.models[0].library_path == str(lib)
    assert settings.models[0].preload is False


def test_chronos2_local_config_keeps_chronos2_lazy_and_opt_in():
    config_path = Path(__file__).resolve().parents[1] / "configs" / "chronos2-local.yaml"

    settings = settings_from_args(["--config", str(config_path)])

    assert settings.forecast.max_horizon == 1024
    assert settings.ui.initial_demo == "chronos2_multiseries"
    assert [model.id for model in settings.models] == ["chronos2-amazon", "fake"]
    chronos = settings.models[0]
    assert chronos.backend == "chronos2"
    assert chronos.model_id == "amazon/chronos-2"
    assert chronos.device == "cpu"
    assert chronos.preload is False
    assert chronos.allow_remote_download is True
    assert settings.models[1].backend == "fake"
    assert settings.models[1].preload is True


def test_cli_backend_override_forces_single_model(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        """
models:
  - id: fake-a
    label: Fake A
    backend: fake
""",
        encoding="utf-8",
    )

    settings = settings_from_args(["--config", str(cfg), "--backend", "fake"])

    assert settings.backend.name == "fake"
    assert settings.models == []


def test_invalid_quantiles_fail(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        """
forecast:
  quantiles: [0.5, 1.2]
""",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="between 0 and 1"):
        settings_from_args(["--config", str(cfg)])
