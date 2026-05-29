from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tsfm_playground.app import create_app
from tsfm_playground.config import BackendSettings, ForecastSettings, ServerSettings, Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(
        server=ServerSettings(),
        backend=BackendSettings(name="fake"),
        forecast=ForecastSettings(horizon=6, quantiles=[0.1, 0.5, 0.9], max_horizon=6),
    )


@pytest.fixture
def client(settings: Settings):
    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client
