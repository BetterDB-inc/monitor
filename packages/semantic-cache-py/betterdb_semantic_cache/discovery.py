from __future__ import annotations

import asyncio
import json
import os
import socket
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .errors import SemanticCacheUsageError

PROTOCOL_VERSION = 1

REGISTRY_KEY = '__betterdb:caches'
PROTOCOL_KEY = '__betterdb:protocol'
HEARTBEAT_KEY_PREFIX = '__betterdb:heartbeat:'

DEFAULT_HEARTBEAT_INTERVAL_S = 30.0
HEARTBEAT_TTL_SECONDS = 60

CACHE_TYPE = 'semantic_cache'

# MarkerMetadata is an open dict — extra keys are allowed.
MarkerMetadata = dict[str, Any]


@dataclass
class DiscoveryOptions:
    enabled: bool = True
    heartbeat_interval_ms: int = 30_000
    include_categories: bool = True


@dataclass
class BuildSemanticMetadataInput:
    name: str
    version: str
    default_threshold: float
    category_thresholds: dict[str, float]
    uncertainty_band: float
    include_categories: bool


def build_semantic_metadata(input: BuildSemanticMetadataInput) -> MarkerMetadata:
    metadata: MarkerMetadata = {
        'type': CACHE_TYPE,
        'prefix': input.name,
        'version': input.version,
        'protocol_version': PROTOCOL_VERSION,
        'capabilities': ['invalidate', 'similarity_distribution', 'threshold_adjust'],
        'index_name': f'{input.name}:idx',
        'stats_key': f'{input.name}:__stats',
        'config_key': f'{input.name}:__config',
        'default_threshold': input.default_threshold,
        'uncertainty_band': input.uncertainty_band,
        'started_at': datetime.now(timezone.utc).isoformat(),
        'pid': os.getpid(),
        'hostname': socket.gethostname(),
    }
    if input.include_categories and input.category_thresholds:
        metadata['category_thresholds'] = dict(input.category_thresholds)
    return metadata


def _err_msg(err: Exception) -> str:
    return str(err)


class DiscoveryManager:
    def __init__(
        self,
        *,
        client: Any,
        name: str,
        build_metadata: Callable[[], MarkerMetadata],
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
            raise SemanticCacheUsageError(
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
