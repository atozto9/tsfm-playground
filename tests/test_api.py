from __future__ import annotations

import re


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_index_serves_forecast_workbench(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "tsfm-playground" in resp.text
    assert 'id="forecast-btn"' in resp.text
    assert 'id="result-chart"' in resp.text
    assert 'id="clear-series-btn"' in resp.text
    assert 'id="drop-zone"' in resp.text
    assert 'id="new-series-btn"' in resp.text
    assert 'id="series-editor"' in resp.text
    assert 'id="editor-mode-draw"' in resp.text
    assert 'id="draw-scope-focus"' in resp.text
    assert 'id="draw-focus-panel"' in resp.text
    assert 'id="draw-overview-canvas"' in resp.text
    assert 'id="draw-span-chip"' in resp.text
    assert 'id="draw-span-start-input"' in resp.text
    assert 'id="draw-span-end-input"' in resp.text
    assert 'id="draw-canvas"' in resp.text
    assert 'id="draw-length-input"' in resp.text
    assert 'id="draw-min-input"' in resp.text
    assert 'id="draw-max-input"' in resp.text
    assert 'id="draw-apply-btn"' in resp.text
    assert 'id="series-list-hint"' in resp.text
    assert 'id="input-context-chip"' in resp.text
    assert 'id="validation-msg"' in resp.text
    assert 'id="context-mode-range"' in resp.text
    assert 'id="context-start-input"' in resp.text
    assert 'id="context-end-input"' in resp.text
    assert 'id="context-summary"' in resp.text
    assert 'id="cancel-edit-btn"' in resp.text
    assert "forecast_utils.js" in resp.text


def test_favicon_is_served(client):
    resp = client.get("/favicon.ico")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/svg+xml")


def test_info_reports_fake_backend(client):
    resp = client.get("/api/info")
    assert resp.status_code == 200
    body = resp.json()
    assert body["backend"] == "fake"
    assert body["model_id"] == "default"
    assert body["loaded"] is True
    assert body["defaults"]["horizon"] == 6
    assert body["capabilities"]["quantiles"] is True


def test_models_reports_active_default(client):
    resp = client.get("/api/models")
    assert resp.status_code == 200
    body = resp.json()
    assert body["models"] == [
        {
            "id": "default",
            "label": "fake",
            "backend": "fake",
            "active": True,
            "loaded": True,
            "source_ref": "fake://linear-trend",
        }
    ]


def test_forecast_runs_against_fake_backend(client):
    payload = {
        "series": [{"id": "a", "name": "A", "values": [1, 2, 4, 7]}],
        "horizon": 3,
        "quantiles": [0.1, 0.5, 0.9],
        "target": "value",
    }
    resp = client.post("/api/forecast", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["backend"] == "fake"
    assert body["model_id"] == "default"
    assert body["input_echo"][0]["stats"]["length"] == 4
    assert body["forecasts"][0]["id"] == "a"
    assert len(body["forecasts"][0]["point"]) == 3
    assert set(body["forecasts"][0]["quantiles"]) == {"0.1", "0.5", "0.9"}
    assert body["context"] == {
        "mode": "full",
        "start_index": None,
        "end_index": None,
        "original_lengths": {},
    }


def test_forecast_echoes_range_context(client):
    payload = {
        "series": [{"id": "a", "name": "A", "values": [2, 4, 7]}],
        "horizon": 2,
        "quantiles": [0.5],
        "target": "value",
        "context": {
            "mode": "range",
            "start_index": 1,
            "end_index": 4,
            "original_lengths": {"a": 4},
        },
    }
    resp = client.post("/api/forecast", json=payload)
    assert resp.status_code == 200
    body = resp.json()
    assert body["context"]["mode"] == "range"
    assert body["context"]["start_index"] == 1
    assert body["context"]["end_index"] == 4
    assert body["context"]["original_lengths"] == {"a": 4}
    assert body["input_echo"][0]["values"] == [2.0, 4.0, 7.0]


def test_forecast_rejects_inconsistent_range_context(client):
    payload = {
        "series": [{"id": "a", "values": [2, 4]}],
        "horizon": 2,
        "quantiles": [0.5],
        "context": {
            "mode": "range",
            "start_index": 1,
            "end_index": 4,
            "original_lengths": {"a": 4},
        },
    }
    resp = client.post("/api/forecast", json=payload)
    assert resp.status_code == 422
    assert "range context length" in resp.text


def test_forecast_validates_future_covariate_length(client):
    payload = {
        "series": [{"id": "a", "values": [1, 2, 3]}],
        "horizon": 3,
        "quantiles": [0.5],
        "covariates": [{"name": "promo", "values": [1, 0], "alignment": "future"}],
    }
    resp = client.post("/api/forecast", json=payload)
    assert resp.status_code == 422
    assert re.search("future covariate", resp.text)


def test_forecast_respects_max_horizon(client):
    payload = {
        "series": [{"id": "a", "values": [1, 2, 3]}],
        "horizon": 7,
        "quantiles": [0.5],
    }
    resp = client.post("/api/forecast", json=payload)
    assert resp.status_code == 422
    assert "max_horizon" in resp.text


def test_parse_file_csv(client):
    resp = client.post(
        "/api/parse-file",
        files={"file": ("sample.csv", b"date,y\n2026-01-01,1\n2026-01-02,2\n")},
    )
    assert resp.status_code == 200
    assert resp.json()["series"] == [{"name": "y", "values": [1.0, 2.0], "timestamps": None}]
