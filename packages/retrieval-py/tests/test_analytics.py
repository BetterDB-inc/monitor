from __future__ import annotations

from typing import Any

import pytest

from betterdb_retrieval.analytics import (
    NOOP_ANALYTICS,
    _PostHogAnalytics,
    create_analytics,
)


class FakePostHog:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.shutdown_called = False
        self.flush_calls = 0

    def capture(self, **kwargs: Any) -> None:
        self.events.append(kwargs)

    def flush(self) -> None:
        self.flush_calls += 1

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
    monkeypatch.setenv("BETTERDB_TELEMETRY", "false")
    assert await create_analytics() is NOOP_ANALYTICS


async def test_create_analytics_no_baked_key_returns_noop() -> None:
    # Baked placeholders are unset in source, so the factory falls back to noop.
    assert await create_analytics() is NOOP_ANALYTICS


async def test_posthog_init_uses_install_id_with_deployment_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BETTERDB_INSTANCE_ID", "install-123")
    ph = FakePostHog()
    client = FakeClient()
    analytics = _PostHogAnalytics(ph)

    await analytics.init(client, "docs", {"fieldCount": 2})

    # The Valkey-scoped deployment id is still generated and persisted via SET.
    assert ("SET",) == client.calls[1][:1]
    deployment = client.store["docs:__instance_id"]
    # distinct_id identifies the install, not the Valkey store.
    assert analytics._distinct_id == "install-123"
    assert analytics._deployment_id == deployment

    # init captures a prefixed retriever_init event tagged with the deployment.
    assert ph.events[0]["event"] == "retrieval:retriever_init"
    assert ph.events[0]["distinct_id"] == "install-123"
    assert ph.events[0]["properties"] == {
        "fieldCount": 2,
        "deployment_id": deployment,
    }
    # The start event is flushed immediately so it lands without an exit hook.
    assert ph.flush_calls >= 1


async def test_posthog_init_reuses_existing_deployment_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("BETTERDB_INSTANCE_ID", "install-123")
    ph = FakePostHog()
    client = FakeClient({"docs:__instance_id": "stable-id"})
    analytics = _PostHogAnalytics(ph)

    await analytics.init(client, "docs")

    assert analytics._distinct_id == "install-123"
    assert analytics._deployment_id == "stable-id"
    # Existing id is reused — no SET write.
    assert all(c[0] != "SET" for c in client.calls)


async def test_install_id_persists_to_disk(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from betterdb_retrieval.analytics import _get_install_id

    monkeypatch.delenv("BETTERDB_INSTANCE_ID", raising=False)
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))

    first = _get_install_id()
    second = _get_install_id()
    assert first == second
    assert (tmp_path / "instance_id").read_text().strip() == first


async def test_posthog_capture_never_raises() -> None:
    class Boom:
        def capture(self, **kwargs: Any) -> None:
            raise RuntimeError("boom")

    analytics = _PostHogAnalytics(Boom())
    # Must not propagate.
    analytics.capture("event", {"k": "v"})


async def test_posthog_shutdown_swallows_errors() -> None:
    ph = FakePostHog()
    analytics = _PostHogAnalytics(ph)
    await analytics.shutdown()
    assert ph.shutdown_called
