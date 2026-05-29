"""FastAPI application factory and CLI entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import anyio
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from .backends import BackendLoadError, ModelManager
from .config import Settings, settings_from_args
from .schemas import (
    ForecastRequest,
    ForecastResponse,
    HealthResponse,
    InfoResponse,
    ModelsResponse,
    ParseFileResponse,
    SwitchRequest,
    SwitchResponse,
)
from .sessions import Session, SessionManager
from .ts_parsing import FileParseError, parse_upload

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).resolve().parent / "static"
SESSION_COOKIE = "tsfm_session"


class SessionCookieMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if getattr(request.state, "_session_created", False):
            session: Session = request.state._session
            response.set_cookie(
                key=SESSION_COOKIE,
                value=session.id,
                httponly=True,
                samesite="lax",
            )
        return response


def _manager(request: Request) -> ModelManager:
    manager: ModelManager | None = getattr(request.app.state, "model_manager", None)
    if manager is None:
        raise HTTPException(503, "Model manager not initialized")
    return manager


def _get_session(request: Request) -> Session:
    if hasattr(request.state, "_session"):
        return request.state._session
    session_mgr: SessionManager | None = getattr(request.app.state, "session_mgr", None)
    if session_mgr is None:
        raise HTTPException(500, "Session manager not initialized")
    cookie_value = request.cookies.get(SESSION_COOKIE)
    session, created = session_mgr.get_or_create(cookie_value)
    request.state._session = session
    request.state._session_created = created
    return session


def _forecast_defaults(settings: Settings) -> dict[str, object]:
    return {
        "horizon": settings.forecast.horizon,
        "quantiles": list(settings.forecast.quantiles),
        "max_horizon": settings.forecast.max_horizon,
        "initial_demo": settings.ui.initial_demo,
    }


def create_app(
    settings: Settings,
    *,
    model_manager: ModelManager | None = None,
    session_mgr: SessionManager | None = None,
) -> FastAPI:
    """Create the FastAPI app."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.model_manager = model_manager or ModelManager.from_settings(settings)
        app.state.model_manager.load_initial()
        app.state.session_mgr = session_mgr or SessionManager(
            default_model_id=app.state.model_manager.default_model_id,
            timeout_s=settings.serving.session_timeout_s,
        )
        try:
            yield
        finally:
            app.state.model_manager = None
            app.state.session_mgr = None

    app = FastAPI(title="tsfm-playground", version="0.1.0", lifespan=lifespan)
    app.add_middleware(SessionCookieMiddleware)

    @app.get("/api/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse()

    @app.get("/api/info", response_model=InfoResponse)
    async def info(request: Request) -> InfoResponse:
        session = _get_session(request)
        return _manager(request).info(session.model_id, _forecast_defaults(settings))

    @app.get("/api/models", response_model=ModelsResponse)
    async def list_models(request: Request) -> ModelsResponse:
        session = _get_session(request)
        return ModelsResponse(models=_manager(request).list_models(session.model_id))

    @app.post("/api/switch", response_model=SwitchResponse)
    async def switch_model(request: Request, body: SwitchRequest) -> SwitchResponse:
        session = _get_session(request)
        try:
            entry = await anyio.to_thread.run_sync(_manager(request).switch_model, body.model_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (BackendLoadError, ImportError, RuntimeError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        request.app.state.session_mgr.update_model(session.id, body.model_id)
        return SwitchResponse(model_id=entry.id, label=entry.label, backend=entry.backend)

    @app.post("/api/parse-file", response_model=ParseFileResponse)
    async def parse_file(file: Annotated[UploadFile, File(...)]) -> ParseFileResponse:
        if not file.filename:
            raise HTTPException(400, "Missing filename")
        data = await file.read()
        if not data:
            raise HTTPException(400, "Empty upload")
        try:
            parsed = parse_upload(file.filename, data)
        except FileParseError as exc:
            raise HTTPException(422, str(exc)) from exc
        return ParseFileResponse(series=parsed)

    @app.post("/api/forecast", response_model=ForecastResponse)
    async def forecast(request: Request, body: ForecastRequest) -> ForecastResponse:
        session = _get_session(request)
        model_id = body.model_id or session.model_id
        if body.horizon > settings.forecast.max_horizon:
            raise HTTPException(
                422,
                f"horizon must be <= configured max_horizon ({settings.forecast.max_horizon}).",
            )
        body = body.model_copy(update={"model_id": model_id})
        try:
            return await anyio.to_thread.run_sync(_manager(request).forecast, model_id, body)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (BackendLoadError, ImportError, RuntimeError, ValueError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.exception_handler(HTTPException)
    async def http_exc_handler(_request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(Exception)
    async def unhandled_exc_handler(_request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled request failure")
        return JSONResponse(status_code=500, content={"detail": str(exc)})

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon_ico() -> FileResponse:
        favicon_path = STATIC_DIR / "favicon.svg"
        if not favicon_path.exists():
            raise HTTPException(404, "Favicon not found")
        return FileResponse(favicon_path, media_type="image/svg+xml")

    if STATIC_DIR.exists():
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    else:
        logger.warning("Static assets directory missing: %s", STATIC_DIR)

    return app


def main(argv: list[str] | None = None) -> None:
    """Entry point for the ``tsfm-playground`` console script."""
    import uvicorn

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
    )
    settings = settings_from_args(argv)
    uvicorn.run(create_app(settings), host=settings.server.host, port=settings.server.port)
