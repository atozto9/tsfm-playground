"""Cookie-based session state for selected model ids."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass


@dataclass
class Session:
    id: str
    model_id: str
    created_at: float
    last_active: float


class SessionManager:
    def __init__(self, default_model_id: str, timeout_s: float = 1800.0) -> None:
        self._default_model_id = default_model_id
        self._timeout_s = timeout_s
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    @property
    def default_model_id(self) -> str:
        return self._default_model_id

    def get_or_create(self, session_id: str | None) -> tuple[Session, bool]:
        now = time.monotonic()
        with self._lock:
            self._prune_expired_locked(now)
            if session_id and session_id in self._sessions:
                session = self._sessions[session_id]
                session.last_active = now
                return session, False
            new_id = str(uuid.uuid4())
            session = Session(
                id=new_id,
                model_id=self._default_model_id,
                created_at=now,
                last_active=now,
            )
            self._sessions[new_id] = session
            return session, True

    def update_model(self, session_id: str, model_id: str) -> None:
        with self._lock:
            self._prune_expired_locked()
            session = self._sessions.get(session_id)
            if session is not None:
                session.model_id = model_id
                session.last_active = time.monotonic()

    def _prune_expired_locked(self, now: float | None = None) -> int:
        if now is None:
            now = time.monotonic()
        expired = [
            session_id
            for session_id, session in self._sessions.items()
            if now - session.last_active >= self._timeout_s
        ]
        for session_id in expired:
            del self._sessions[session_id]
        return len(expired)
