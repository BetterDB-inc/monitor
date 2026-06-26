from __future__ import annotations

import asyncio
import json
import os
import socket
import warnings
from datetime import datetime, timezone
from typing import Any, Callable

from betterdb_agent_cache.discovery import (
    DEFAULT_HEARTBEAT_INTERVAL_S,
    HEARTBEAT_KEY_PREFIX,
    HEARTBEAT_TTL_SECONDS,
    PROTOCOL_KEY,
    PROTOCOL_VERSION,
    REGISTRY_KEY,
)

from .types import MemoryStoreClient

MEMORY_CACHE_TYPE = "agent_memory"
MEMORY_CAPABILITIES = ["recall", "consolidate", "reinforce"]


class MemoryDiscovery:
    def __init__(
        self,
        *,
        client: MemoryStoreClient,
        name: str,
        version: str,
        stats_key: str,
        heartbeat_interval_s: float | None = None,
        on_write_failed: Callable[[], None] | None = None,
    ) -> None:
        self._client = client
        self._name = name
        self._version = version
        self._stats_key = stats_key
        self._heartbeat_interval_s = (
            heartbeat_interval_s
            if heartbeat_interval_s is not None
            else DEFAULT_HEARTBEAT_INTERVAL_S
        )
        # Namespace the marker under `{name}:mem` so a memory store and an
        # agent-cache sharing the same name register distinct registry fields
        # and heartbeat keys instead of clobbering each other.
        self._marker_field = f"{name}:mem"
        self._heartbeat_key = f"{HEARTBEAT_KEY_PREFIX}{self._marker_field}"
        self._started_at = datetime.now(timezone.utc).isoformat()
        self._on_write_failed: Callable[[], None] = on_write_failed or (lambda: None)
        self._heartbeat_task: asyncio.Task[None] | None = None

    def build_marker(self) -> dict[str, Any]:
        return {
            "type": MEMORY_CACHE_TYPE,
            "prefix": self._name,
            "version": self._version,
            "protocol_version": PROTOCOL_VERSION,
            "capabilities": list(MEMORY_CAPABILITIES),
            "stats_key": self._stats_key,
            "started_at": self._started_at,
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
        }

    async def register(self) -> None:
        # HGET-then-HSET is not atomic (TOCTOU); acceptable for best-effort
        # discovery — a racing writer just means last-writer-wins on the marker.
        existing = await self._safe_hget()
        if existing is not None:
            self._check_collision(existing)
        await self._write_marker()
        await self._safe_call(
            lambda: self._client.execute_command("SET", PROTOCOL_KEY, str(PROTOCOL_VERSION), "NX")
        )
        await self._write_heartbeat()
        self._start_heartbeat()

    async def stop(self, *, delete_heartbeat: bool) -> None:
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except (asyncio.CancelledError, Exception):
                pass
            self._heartbeat_task = None
        if not delete_heartbeat:
            return
        try:
            await self._client.execute_command("DEL", self._heartbeat_key)
        except Exception:
            self._on_write_failed()

    async def tick_heartbeat(self) -> None:
        await self._write_heartbeat()
        await self._write_marker()
        # PROTOCOL_KEY is set once in register(); the NX SET is a guaranteed
        # no-op on every subsequent tick, so it's not re-issued here.

    def _start_heartbeat(self) -> None:
        async def _loop() -> None:
            try:
                while True:
                    await asyncio.sleep(self._heartbeat_interval_s)
                    await self.tick_heartbeat()
            except asyncio.CancelledError:
                pass

        self._heartbeat_task = asyncio.create_task(_loop())

    async def _write_heartbeat(self) -> None:
        now = datetime.now(timezone.utc).isoformat()
        try:
            await self._client.execute_command(
                "SET", self._heartbeat_key, now, "EX", str(HEARTBEAT_TTL_SECONDS)
            )
        except Exception:
            self._on_write_failed()

    async def _write_marker(self) -> None:
        try:
            payload = json.dumps(self.build_marker())
        except Exception:
            self._on_write_failed()
            return
        await self._safe_call(
            lambda: self._client.execute_command("HSET", REGISTRY_KEY, self._marker_field, payload)
        )

    async def _safe_hget(self) -> str | None:
        try:
            value = await self._client.execute_command("HGET", REGISTRY_KEY, self._marker_field)
            if value is None:
                return None
            return value.decode() if isinstance(value, bytes) else str(value)
        except Exception:
            self._on_write_failed()
            return None

    async def _safe_call(self, fn: Callable[[], Any]) -> None:
        try:
            await fn()
        except Exception:
            self._on_write_failed()

    def _check_collision(self, existing_json: str) -> None:
        try:
            parsed = json.loads(existing_json)
        except Exception:
            return
        existing_type = parsed.get("type") if isinstance(parsed, dict) else None
        if existing_type and existing_type != MEMORY_CACHE_TYPE:
            # The memory marker lives under `{name}:mem`, distinct from
            # agent-cache's `{name}`, so the two tiers never collide here.
            # Surface it with a visible warning rather than raising into a
            # swallowed registration; registration then proceeds
            # last-writer-wins, matching agent-cache.
            warnings.warn(
                f"agent-memory discovery: field '{self._marker_field}' already holds a "
                f"'{existing_type}' marker; overwriting",
                stacklevel=2,
            )
