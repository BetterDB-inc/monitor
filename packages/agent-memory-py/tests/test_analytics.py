from __future__ import annotations

from typing import Any

import pytest

from betterdb_agent_memory.analytics import (
    NOOP_ANALYTICS,
    _PostHogAnalytics,
    create_analytics,
)


class FakePostHog:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.shutdown_called = False

    def capture(self, **kwargs: Any) -> None:
        self.events.append(kwargs)

    def shutdown(self) -> None:
        self.shutdown_called = True


class FakeClient:
    def __init__(self, store: dict[str, str] | None = None) -> None:
        self.store = store or {}
        self.calls: list[tuple[Any, ...]] = []

    async def execute_command(self, *args: Any) -> Any:
        self.calls.append(args)
        if args[0] == "GET":
            return self.store.get(args[1])
        if args[0] == "SET":
            self.store[args[1]] = args[2]
            return "OK"
        return None


async def test_create_analytics_disabled_returns_noop() -> None:
    assert await create_analytics(disabled=True) is NOOP_ANALYTICS


async def test_create_analytics_opt_out_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BETTERDB_TELEMETRY", "off")
    assert await create_analytics() is NOOP_ANALYTICS


async def test_create_analytics_no_baked_key_returns_noop() -> None:
    assert await create_analytics() is NOOP_ANALYTICS


async def test_posthog_init_persists_instance_id_and_captures() -> None:
    ph = FakePostHog()
    client = FakeClient()
    analytics = _PostHogAnalytics(ph)

    await analytics.init(client, "agent", {"hasEmbedFn": True})

    persisted = client.store["agent:__instance_id"]
    assert analytics._distinct_id == persisted
    assert ph.events[0]["event"] == "agent_memory:memory_init"
    assert ph.events[0]["distinct_id"] == persisted
    assert ph.events[0]["properties"] == {"hasEmbedFn": True}


async def test_posthog_init_reuses_existing_instance_id() -> None:
    ph = FakePostHog()
    client = FakeClient({"agent:__instance_id": "stable-id"})
    analytics = _PostHogAnalytics(ph)

    await analytics.init(client, "agent")

    assert analytics._distinct_id == "stable-id"
    assert all(c[0] != "SET" for c in client.calls)


async def test_posthog_capture_never_raises() -> None:
    class Boom:
        def capture(self, **kwargs: Any) -> None:
            raise RuntimeError("boom")

    _PostHogAnalytics(Boom()).capture("event", {"k": "v"})


async def test_posthog_shutdown_swallows_errors() -> None:
    ph = FakePostHog()
    analytics = _PostHogAnalytics(ph)
    await analytics.shutdown()
    assert ph.shutdown_called
