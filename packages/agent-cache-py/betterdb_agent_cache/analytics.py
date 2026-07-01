"""Product analytics for agent-cache.

Uses ``posthog`` as an optional dependency with a no-op fallback.
Identity is a per-install UUID persisted on the local machine (so a fleet
sharing one Valkey is counted as many installs, not one); the Valkey-scoped
id is attached to every event as a ``deployment_id`` property for roll-up.

Opt out by setting ``BETTERDB_TELEMETRY=false`` (or ``0 / no / off``).
"""
from __future__ import annotations

import asyncio
import atexit
import os
import uuid
from pathlib import Path
from typing import Any


_EVENT_PREFIX = "agent_cache:"

# Build-time placeholders — replaced by hatch_build.py during wheel build.
# When the placeholder is NOT replaced, the startswith('__') guard treats it as unset.
_BAKED_POSTHOG_API_KEY = "__BETTERDB_POSTHOG_API_KEY__"
_BAKED_POSTHOG_HOST = "__BETTERDB_POSTHOG_HOST__"


def _is_opted_out() -> bool:
    val = os.environ.get("BETTERDB_TELEMETRY", "")
    return val.lower() in ("false", "0", "no", "off")


_INSTALL_ID_ENV = "BETTERDB_INSTANCE_ID"

# Process-lifetime fallback for when the on-disk id can't be read or written, so
# a single process doesn't mint a fresh id (and a new distinct_id) on every call.
_ephemeral_install_id: str | None = None


def _install_id_path() -> Path:
    base = os.environ.get("XDG_STATE_HOME")
    root = Path(base) if base else Path.home() / ".betterdb"
    return root / "instance_id"


def _get_install_id() -> str:
    """Stable per-install identity for product analytics.

    Persisted on the local machine (not in Valkey), so a fleet of processes
    sharing one Valkey is counted as many installs rather than collapsing to
    one. Pin it via ``BETTERDB_INSTANCE_ID`` for ephemeral containers that
    would otherwise mint a fresh id every run. Falls back to an ephemeral
    per-process id when no writable location is available.
    """
    override = os.environ.get(_INSTALL_ID_ENV)
    if override:
        return override
    path = _install_id_path()
    try:
        existing = path.read_text().strip()
        if existing:
            return existing
    except Exception:
        pass
    global _ephemeral_install_id
    new_id = _ephemeral_install_id or str(uuid.uuid4())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(new_id)
    except Exception:
        # Persistence failed — hold the id for the rest of this process so
        # repeated calls return a stable ephemeral identity.
        _ephemeral_install_id = new_id
    return new_id


class Analytics:
    """No-op fallback used when PostHog is unavailable or telemetry is disabled."""

    async def init(self, client: Any, name: str, props: dict[str, Any] | None = None) -> None:
        pass

    def capture(self, event: str, properties: dict[str, Any] | None = None) -> None:
        pass

    def flush(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass


NOOP_ANALYTICS = Analytics()


class _PostHogAnalytics(Analytics):
    def __init__(self, posthog: Any) -> None:
        self._ph = posthog
        self._distinct_id = ""
        self._deployment_id = ""
        # Library consumers are frequently short-lived scripts that never call
        # close()/shutdown(), so PostHog's buffered events (flush_at=20,
        # flush_interval=10s) would be dropped when the interpreter exits before
        # the background queue drains. Register a best-effort flush at exit so
        # the init/lifecycle events are actually delivered. Only enabled
        # instances reach here — the opt-out path returns NOOP_ANALYTICS and
        # registers nothing, keeping disabled consumers completely silent.
        atexit.register(self._flush_atexit)

    async def init(self, client: Any, name: str, props: dict[str, Any] | None = None) -> None:
        self._distinct_id = _get_install_id()
        self._deployment_id = await self._resolve_deployment_id(client, name)
        merged = dict(props) if props else {}
        if self._deployment_id:
            merged["deployment_id"] = self._deployment_id
        self.capture("cache_init", merged)
        # Flush the start event immediately so it lands even for processes that
        # exit before the flush interval or any exit hook fires. Off-loaded to a
        # thread so the network round-trip doesn't stall the event loop.
        await asyncio.to_thread(self.flush)

    async def _resolve_deployment_id(self, client: Any, name: str) -> str:
        # The Valkey-scoped id groups all clients pointed at the same store, so
        # a shared-Valkey fleet can still be rolled up into one deployment.
        id_key = f"{name}:__instance_id"
        try:
            existing = await client.get(id_key)
            if existing:
                return existing.decode() if isinstance(existing, bytes) else existing
            new_id = str(uuid.uuid4())
            await client.set(id_key, new_id)
            return new_id
        except Exception:
            return ""

    def capture(self, event: str, properties: dict[str, Any] | None = None) -> None:
        try:
            props = dict(properties) if properties else {}
            if self._deployment_id:
                props.setdefault("deployment_id", self._deployment_id)
            self._ph.capture(
                distinct_id=self._distinct_id,
                event=f"{_EVENT_PREFIX}{event}",
                properties=props,
            )
        except Exception:
            pass

    def flush(self) -> None:
        try:
            self._ph.flush()
        except Exception:
            pass

    def _flush_atexit(self) -> None:
        self.flush()

    async def shutdown(self) -> None:
        # Explicit shutdown supersedes the atexit backstop.
        try:
            atexit.unregister(self._flush_atexit)
        except Exception:
            pass
        try:
            await self._ph.ashutdown()
        except AttributeError:
            try:
                self._ph.shutdown()
            except Exception:
                pass
        except Exception:
            pass


async def create_analytics(disabled: bool = False) -> Analytics:
    """Return a PostHog-backed Analytics instance, or the no-op fallback."""
    if disabled or _is_opted_out():
        return NOOP_ANALYTICS

    api_key = None if _BAKED_POSTHOG_API_KEY.startswith("__") else _BAKED_POSTHOG_API_KEY
    if not api_key:
        return NOOP_ANALYTICS

    host = None if _BAKED_POSTHOG_HOST.startswith("__") else _BAKED_POSTHOG_HOST

    try:
        from posthog import Posthog  # type: ignore[import]

        ph = Posthog(
            api_key,
            host=host or "https://app.posthog.com",
            flush_at=20,
            flush_interval=10,
        )
        return _PostHogAnalytics(ph)
    except ImportError:
        return NOOP_ANALYTICS
    except Exception:
        return NOOP_ANALYTICS
