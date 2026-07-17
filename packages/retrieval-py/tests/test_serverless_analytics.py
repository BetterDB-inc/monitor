from __future__ import annotations

import sys
from typing import Any

import pytest

from betterdb_retrieval import analytics as analytics_module
from betterdb_retrieval.analytics import (
    NOOP_ANALYTICS,
    _is_frozen_serverless,
    _PostHogAnalytics,
    create_analytics,
)

SERVERLESS_VARS = (
    "AWS_LAMBDA_FUNCTION_NAME",
    "K_SERVICE",
    "FUNCTION_TARGET",
    "FUNCTIONS_WORKER_RUNTIME",
)


class FakePostHog:
    """Records the constructor kwargs create_analytics chose."""

    instances: list[FakePostHog] = []

    def __init__(self, api_key: str, **kwargs: Any) -> None:
        self.api_key = api_key
        self.kwargs = kwargs
        self.events: list[dict[str, Any]] = []
        FakePostHog.instances.append(self)

    def capture(self, **kwargs: Any) -> None:
        self.events.append(kwargs)

    def flush(self) -> None:
        pass

    def shutdown(self) -> None:
        pass


@pytest.fixture(autouse=True)
def _clean_serverless_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # A real CI runner may set none of these, but a developer's shell might;
    # clear them so detection is driven only by what each test sets.
    for var in SERVERLESS_VARS:
        monkeypatch.delenv(var, raising=False)
    FakePostHog.instances = []


@pytest.fixture
def fake_posthog(monkeypatch: pytest.MonkeyPatch) -> type[FakePostHog]:
    module = type(sys)("posthog")
    module.Posthog = FakePostHog  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "posthog", module)
    # Past the placeholder guard, which would otherwise return NOOP_ANALYTICS.
    monkeypatch.setattr(analytics_module, "_BAKED_POSTHOG_API_KEY", "phc_test_key")
    monkeypatch.setattr(analytics_module, "_BAKED_POSTHOG_HOST", "https://eu.posthog.com")
    return FakePostHog


@pytest.mark.parametrize("var", SERVERLESS_VARS)
def test_is_frozen_serverless_detects_each_runtime(
    monkeypatch: pytest.MonkeyPatch, var: str
) -> None:
    monkeypatch.setenv(var, "some-value")
    assert _is_frozen_serverless() is True


def test_is_frozen_serverless_false_on_a_long_lived_server() -> None:
    assert _is_frozen_serverless() is False


def test_is_frozen_serverless_ignores_an_empty_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "")
    assert _is_frozen_serverless() is False


async def test_flush_at_is_one_on_frozen_serverless(
    monkeypatch: pytest.MonkeyPatch, fake_posthog: type[FakePostHog]
) -> None:
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "my-fn")

    await create_analytics()

    assert len(fake_posthog.instances) == 1
    # The container freezes on return, so buffering to 20 would strand events.
    assert fake_posthog.instances[0].kwargs["flush_at"] == 1


async def test_flush_at_is_batched_on_a_long_lived_server(
    fake_posthog: type[FakePostHog],
) -> None:
    await create_analytics()

    assert len(fake_posthog.instances) == 1
    assert fake_posthog.instances[0].kwargs["flush_at"] == 20


async def test_create_analytics_returns_noop_without_a_baked_key() -> None:
    assert await create_analytics() is NOOP_ANALYTICS


async def test_create_analytics_opt_out_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BETTERDB_TELEMETRY", "false")
    assert await create_analytics() is NOOP_ANALYTICS


def test_capture_tags_events_with_the_sdk_user_agent() -> None:
    ph = FakePostHog("phc_test_key")
    subject = _PostHogAnalytics(ph)

    subject.capture("retrieval_init", {"tier": "exact"})

    assert len(ph.events) == 1
    properties = ph.events[0]["properties"]
    # Classifies the SDK as non-bot at ingestion; without it these events are
    # filtered out of product analytics entirely.
    assert properties["$raw_user_agent"] == "BetterDB-Retrieval/python"
    assert properties["tier"] == "exact"


def test_capture_does_not_override_an_explicit_user_agent() -> None:
    ph = FakePostHog("phc_test_key")
    subject = _PostHogAnalytics(ph)

    subject.capture("retrieval_init", {"$raw_user_agent": "Caller/1.0"})

    assert ph.events[0]["properties"]["$raw_user_agent"] == "Caller/1.0"
