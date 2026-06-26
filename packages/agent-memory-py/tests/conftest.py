from __future__ import annotations

import hashlib
import inspect
import math
import time
from collections.abc import Callable
from typing import Any

import pytest


# --- deterministic embedding (mirrors helpers/fakeEmbed.ts) -----------------


def fake_embed(dims: int) -> Callable[[str], Any]:
    """Deterministic, dimension-configurable embedding for hermetic tests.

    The same text always maps to the same normalized vector, matching the TS
    ``fakeEmbed`` byte-for-byte (sha256 hex, two hex chars per dim mod 32).
    """

    async def embed(text: str) -> list[float]:
        digest = hashlib.sha256(text.encode()).hexdigest()
        vec: list[float] = []
        for i in range(dims):
            offset = (i % 32) * 2
            vec.append(int(digest[offset : offset + 2], 16) / 255)
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    return embed


# --- async command mock (mirrors helpers/mockClient.ts) ---------------------

CommandHandler = Callable[..., Any]


class FakeClient:
    """Minimal valkey-style mock: an ``execute_command`` spy backed by a handler.

    Records every call as a list ``[command, *args]`` (decoding a bytes command
    name) and returns the handler's result, awaiting it when the handler hands
    back a coroutine (used by the eviction-snapshot test to refresh config
    mid-pass). Default handler returns ``"OK"``.
    """

    def __init__(self, handler: CommandHandler | None = None) -> None:
        self.calls: list[list[Any]] = []
        self._handler: CommandHandler = handler if handler is not None else (lambda *_: "OK")

    async def execute_command(self, *args: Any) -> Any:
        self.calls.append(list(args))
        command = args[0]
        if isinstance(command, bytes):
            command = command.decode()
        result = self._handler(command, *args[1:])
        if inspect.isawaitable(result):
            result = await result
        return result

    def find_call(self, command: str) -> list[Any] | None:
        for call in self.calls:
            if call and call[0] == command:
                return call
        return None

    def calls_for(self, command: str) -> list[list[Any]]:
        return [call for call in self.calls if call and call[0] == command]

    def commands(self) -> list[Any]:
        return [call[0] for call in self.calls if call]


def fake_client(handler: CommandHandler | None = None) -> FakeClient:
    return FakeClient(handler)


# --- FT.SEARCH reply builders ----------------------------------------------


def flat_fields(fields: dict[str, str]) -> list[str]:
    out: list[str] = []
    for name, value in fields.items():
        out.extend([name, value])
    return out


def ft_reply(total: int, rows: list[tuple[str, dict[str, str]]] | None = None) -> list[Any]:
    out: list[Any] = [str(total)]
    for key, fields in rows or []:
        out.append(key)
        out.append(flat_fields(fields))
    return out


def search_reply(rows: list[tuple[str, dict[str, str]]]) -> list[Any]:
    return ft_reply(len(rows), rows)


def now_ms() -> int:
    return int(time.time() * 1000)


# --- telemetry isolation ----------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_metric_cache() -> Any:
    """Reset the module-level prom metric cache so each test's fresh registry
    gets fresh collectors (CPython can recycle ``id()`` across registries)."""
    from betterdb_agent_memory import telemetry

    telemetry._metric_cache.clear()
    yield
    telemetry._metric_cache.clear()


_EXPORTER: Any = None


@pytest.fixture
def span_exporter() -> Any:
    """In-memory OpenTelemetry span exporter wired to the global tracer provider.

    The provider is installed once per session (set_tracer_provider is a no-op
    on later calls); the exporter is cleared per test.
    """
    global _EXPORTER
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    if _EXPORTER is None:
        _EXPORTER = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(_EXPORTER))
        trace.set_tracer_provider(provider)
    _EXPORTER.clear()
    return _EXPORTER
