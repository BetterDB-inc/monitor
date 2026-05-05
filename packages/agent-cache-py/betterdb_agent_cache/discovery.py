from __future__ import annotations

import asyncio
import json
import os
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .errors import AgentCacheUsageError
from .types import DiscoveryOptions  # single source of truth

PROTOCOL_VERSION = 1

REGISTRY_KEY = '__betterdb:caches'
PROTOCOL_KEY = '__betterdb:protocol'
HEARTBEAT_KEY_PREFIX = '__betterdb:heartbeat:'

DEFAULT_HEARTBEAT_INTERVAL_S = 30.0
HEARTBEAT_TTL_SECONDS = 60

TOOL_POLICIES_LIMIT = 500

CACHE_TYPE = 'agent_cache'


@dataclass
class TierMarkerInfo:
    enabled: bool
    ttl_default: int | None = None


@dataclass
class BuildAgentMetadataInput:
    name: str
    version: str
    tiers: dict[str, dict[str, Any]]
    default_ttl: int | None
    tool_policy_names: list[str]
    has_cost_table: bool
    uses_default_cost_table: bool
    started_at: str
    include_tool_policies: bool


def build_agent_metadata(input: BuildAgentMetadataInput) -> dict[str, Any]:
    def tier_marker(ttl: int | None) -> dict[str, Any]:
        effective_ttl = ttl if ttl is not None else input.default_ttl
        result: dict[str, Any] = {'enabled': True}
        if effective_ttl is not None:
            result['ttl_default'] = effective_ttl
        return result

    llm_ttl = input.tiers.get('llm', {}).get('ttl')
    tool_ttl = input.tiers.get('tool', {}).get('ttl')
    session_ttl = input.tiers.get('session', {}).get('ttl')

    metadata: dict[str, Any] = {
        'type': CACHE_TYPE,
        'prefix': input.name,
        'version': input.version,
        'protocol_version': PROTOCOL_VERSION,
        'capabilities': ['tool_ttl_adjust', 'invalidate_by_tool', 'tool_effectiveness'],
        'stats_key': f'{input.name}:__stats',
        'tiers': {
            'llm': tier_marker(llm_ttl),
            'tool': tier_marker(tool_ttl),
            'session': tier_marker(session_ttl),
        },
        'has_cost_table': input.has_cost_table,
        'uses_default_cost_table': input.uses_default_cost_table,
        'started_at': input.started_at,
        'pid': os.getpid(),
        'hostname': socket.gethostname(),
    }

    if input.include_tool_policies:
        names = input.tool_policy_names
        if len(names) > TOOL_POLICIES_LIMIT:
            metadata['tool_policies'] = names[:TOOL_POLICIES_LIMIT]
            metadata['tool_policies_truncated'] = True
        else:
            metadata['tool_policies'] = list(names)

    return metadata


def _err_msg(err: Exception) -> str:
    return str(err)


class DiscoveryManager:
    def __init__(
        self,
        *,
        client: Any,
        name: str,
        build_metadata: Callable[[], dict[str, Any]],
        heartbeat_interval_s: float = DEFAULT_HEARTBEAT_INTERVAL_S,
        logger: Any = None,
        on_write_failed: Callable[[], None] | None = None,
    ) -> None:
        self._client = client
        self._name = name
        self._build_metadata = build_metadata
        self._heartbeat_interval_s = heartbeat_interval_s
        self._heartbeat_key = f'{HEARTBEAT_KEY_PREFIX}{name}'
        self._logger = logger
        self._on_write_failed: Callable[[], None] = on_write_failed or (lambda: None)
        self._heartbeat_task: asyncio.Task[None] | None = None

    def _warn(self, msg: str) -> None:
        if self._logger is not None:
            self._logger.warning(msg)

    def _debug(self, msg: str) -> None:
        if self._logger is not None:
            self._logger.debug(msg)

    async def register(self) -> None:
        existing_json = await self._safe_hget()
        if existing_json is not None:
            self._check_collision(existing_json)

        await self._write_metadata()
        await self._safe_call(
            lambda: self._client.set(PROTOCOL_KEY, str(PROTOCOL_VERSION), 'NX'),
            'SET protocol',
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
            await self._client.delete(self._heartbeat_key)
        except Exception as err:
            self._debug(f'discovery: DEL heartbeat failed: {_err_msg(err)}')

    async def tick_heartbeat(self) -> None:
        await self._write_heartbeat()
        await self._write_metadata()
        await self._safe_call(
            lambda: self._client.set(PROTOCOL_KEY, str(PROTOCOL_VERSION), 'NX'),
            'SET protocol (heartbeat)',
        )

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
            await self._client.set(self._heartbeat_key, now, 'EX', HEARTBEAT_TTL_SECONDS)
        except Exception as err:
            self._debug(f'discovery: heartbeat SET failed: {_err_msg(err)}')
            self._on_write_failed()

    async def _write_metadata(self) -> None:
        try:
            payload = json.dumps(self._build_metadata())
        except Exception as err:
            self._warn(f'discovery: metadata serialise failed: {_err_msg(err)}')
            self._on_write_failed()
            return
        await self._safe_call(
            lambda: self._client.hset(REGISTRY_KEY, self._name, payload),
            'HSET registry',
        )

    async def _safe_hget(self) -> str | None:
        try:
            result = await self._client.hget(REGISTRY_KEY, self._name)
            if result is None:
                return None
            return result.decode() if isinstance(result, bytes) else result
        except Exception as err:
            self._warn(f'discovery: HGET registry failed: {_err_msg(err)}')
            self._on_write_failed()
            return None

    async def _safe_call(self, fn: Callable[[], Any], label: str) -> None:
        try:
            await fn()
        except Exception as err:
            self._warn(f'discovery: {label} failed: {_err_msg(err)}')
            self._on_write_failed()

    def _check_collision(self, existing_json: str) -> None:
        try:
            parsed: dict[str, Any] = json.loads(existing_json)
        except Exception:
            return

        existing_type = parsed.get('type')
        if existing_type and existing_type != CACHE_TYPE:
            raise AgentCacheUsageError(
                f"cache name collision: '{self._name}' is already registered as type "
                f"'{existing_type}' on this Valkey instance"
            )

        new_meta = self._build_metadata()
        existing_version = parsed.get('version')
        new_version = new_meta.get('version')
        if existing_version and existing_version != new_version:
            self._warn(
                f"discovery: overwriting marker for '{self._name}' "
                f"(existing version {existing_version}, this version {new_version})"
            )
