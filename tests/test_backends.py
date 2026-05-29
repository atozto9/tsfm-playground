from __future__ import annotations

import sys
from pathlib import Path

from tsfm_playground.backends import _forecast_series_from_dataframe, load_backend_from_settings
from tsfm_playground.config import BackendSettings
from tsfm_playground.schemas import ForecastRequest


def test_custom_backend_loads_from_library_path(tmp_path: Path):
    package = tmp_path / "custom_pkg"
    package.mkdir()
    (package / "__init__.py").write_text(
        """
from tsfm_playground.schemas import BackendCapabilities, ForecastResponse, ForecastSeriesOut
from tsfm_playground.forecast import build_input_echo

class Adapter:
    capabilities = {"multivariate": True, "covariates": False, "quantiles": True}

    def load(self, cfg):
        self.cfg = cfg

    def info(self):
        return {"loaded_from": self.cfg.model_path}

    def forecast(self, req):
        return ForecastResponse(
            forecasts=[
                ForecastSeriesOut(
                    id=req.series[0].id or "series_0",
                    point=[1.0] * req.horizon,
                )
            ],
            input_echo=build_input_echo(req),
            backend="custom",
            model_id=req.model_id,
            prep_time_s=0.0,
            forecast_time_s=0.0,
        )
""",
        encoding="utf-8",
    )

    try:
        backend = load_backend_from_settings(
            BackendSettings(
                name="custom",
                library_path=str(tmp_path),
                adapter_class="custom_pkg:Adapter",
                model_path="/tmp/model",
            )
        )
        resp = backend.forecast(
            ForecastRequest(
                series=[{"id": "a", "values": [1.0, 2.0]}],
                horizon=2,
                quantiles=[0.5],
            )
        )
    finally:
        sys.path = [path for path in sys.path if path != str(tmp_path)]

    assert backend.info_extra()["loaded_from"] == "/tmp/model"
    assert resp.forecasts[0].point == [1.0, 1.0]


def test_chronos2_backend_loads_from_optional_library_path(tmp_path: Path, monkeypatch):
    package = tmp_path / "chronos"
    package.mkdir()
    (package / "__init__.py").write_text(
        """
class Chronos2Pipeline:
    calls = []

    @classmethod
    def from_pretrained(cls, source, **kwargs):
        cls.calls.append((source, kwargs))
        return cls()
""",
        encoding="utf-8",
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "chronos", raising=False)

    backend = load_backend_from_settings(
        BackendSettings(
            name="chronos2",
            library_path=str(tmp_path),
            model_path="/tmp/chronos-2",
            device="cpu",
            backend_options={"attn_implementation": "eager"},
        )
    )

    chronos = sys.modules["chronos"]
    assert backend.source_ref == "/tmp/chronos-2"
    assert backend.info_extra()["adapter"] == "Chronos2Pipeline.predict_df"
    assert chronos.Chronos2Pipeline.calls == [
        (
            "/tmp/chronos-2",
            {"attn_implementation": "eager", "device_map": "cpu"},
        )
    ]


class FakeColumn(list):
    def __eq__(self, other):
        return [value == other for value in self]

    def tolist(self):
        return list(self)


class FakeDataFrame:
    def __init__(self, rows):
        self.rows = list(rows)
        self.columns = list(self.rows[0]) if self.rows else []

    def __getitem__(self, key):
        if isinstance(key, str):
            return FakeColumn([row.get(key) for row in self.rows])
        return FakeDataFrame([row for row, keep in zip(self.rows, key, strict=True) if keep])

    def head(self, count):
        return FakeDataFrame(self.rows[:count])


def test_chronos2_dataframe_output_prefers_predictions_point_column():
    pred_df = FakeDataFrame(
        [
            {"id": "a", "timestamp": "t0", "predictions": 10.0, "0.1": 8.0, "0.5": 9.0},
            {"id": "a", "timestamp": "t1", "predictions": 11.0, "0.1": 9.0, "0.5": 10.0},
        ]
    )
    req = ForecastRequest(
        series=[{"id": "a", "values": [1.0, 2.0]}],
        horizon=2,
        quantiles=[0.1, 0.5],
    )

    out = _forecast_series_from_dataframe(pred_df, req)

    assert out[0].point == [10.0, 11.0]
    assert out[0].quantiles == {"0.1": [8.0, 9.0], "0.5": [9.0, 10.0]}
    assert out[0].timestamps is None


def test_chronos2_dataframe_output_preserves_timestamps_when_input_has_timestamps():
    pred_df = FakeDataFrame(
        [
            {"id": "a", "timestamp": "2026-01-03", "predictions": 10.0},
            {"id": "a", "timestamp": "2026-01-04", "predictions": 11.0},
        ]
    )
    req = ForecastRequest(
        series=[
            {
                "id": "a",
                "values": [1.0, 2.0],
                "timestamps": ["2026-01-01", "2026-01-02"],
            }
        ],
        horizon=2,
        quantiles=[0.5],
    )

    out = _forecast_series_from_dataframe(pred_df, req)

    assert out[0].point == [10.0, 11.0]
    assert out[0].timestamps == ["2026-01-03", "2026-01-04"]
