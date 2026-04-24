"""Product analytics for semantic-cache.

Uses ``posthog`` as an optional dependency with a no-op fallback.
Instance identity is a UUID persisted in Valkey so it stays stable
across process restarts.

Opt out by setting ``BETTERDB_TELEMETRY=false`` (or ``0 / no / off``).
"""
from __future__ import annotations

import os
import uuid
from typing import Any


_EVENT_PREFIX = "semantic_cache:"

# Build-time placeholders — replaced by hatch_build.py during wheel build.
# When the placeholder is NOT replaced, the startswith('__') guard treats it as unset.
_BAKED_POSTHOG_API_KEY = "__BETTERDB_POSTHOG_API_KEY__"
_BAKED_POSTHOG_HOST = "__BETTERDB_POSTHOG_HOST__"


def _is_opted_out() -> bool:
    val = os.environ.get("BETTERDB_TELEMETRY", "")
    return val.lower() in ("false", "0", "no", "off")


class Analytics:
    """No-op fallback used when PostHog is unavailable or telemetry is disabled."""

    async def init(self, client: Any, name: str, props: dict[str, Any] | None = None) -> None:
        pass

    def capture(self, event: str, properties: dict[str, Any] | None = None) -> None:
        pass

    async def shutdown(self) -> None:
        pass


NOOP_ANALYTICS = Analytics()


class _PostHogAnalytics(Analytics):
    def __init__(self, posthog: Any) -> None:
        self._ph = posthog
        self._distinct_id = ""

    async def init(self, client: Any, name: str, props: dict[str, Any] | None = None) -> None:
        id_key = f"{name}:__instance_id"
        try:
            existing = await client.get(id_key)
            if existing:
                self._distinct_id = (
                    existing.decode() if isinstance(existing, bytes) else existing
                )
            else:
                new_id = str(uuid.uuid4())
                await client.set(id_key, new_id)
                self._distinct_id = new_id
        except Exception:
            self._distinct_id = str(uuid.uuid4())

        self.capture("cache_init", props)

    def capture(self, event: str, properties: dict[str, Any] | None = None) -> None:
        try:
            self._ph.capture(
                distinct_id=self._distinct_id,
                event=f"{_EVENT_PREFIX}{event}",
                properties=properties,
            )
        except Exception:
            pass

    async def shutdown(self) -> None:
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
