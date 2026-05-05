"""Tests for the discovery marker protocol."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache.discovery import (
    HEARTBEAT_KEY_PREFIX,
    HEARTBEAT_TTL_SECONDS,
    PROTOCOL_KEY,
    PROTOCOL_VERSION,
    REGISTRY_KEY,
    BuildSemanticMetadataInput,
    DiscoveryManager,
    build_semantic_metadata,
)
from betterdb_semantic_cache.errors import SemanticCacheUsageError


# ---------------------------------------------------------------------------
# Fake Valkey client — implements only the subset DiscoveryManager needs
# ---------------------------------------------------------------------------

class FakeClient:
    """In-memory Valkey stub. All methods are coroutines."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.strings: dict[str, dict[str, Any]] = {}
        self.hget_calls: int = 0
        self.hset_calls: int = 0
        self.set_calls: list[dict[str, Any]] = []
        self.del_calls: list[str] = []

        self._fail_next_hget = False
        self._fail_next_hset = False
        self._fail_sets_matching: Any = None

    def fail_hget_once(self) -> None:
        self._fail_next_hget = True

    def fail_hset_once(self) -> None:
        self._fail_next_hset = True

    def fail_sets_matching_predicate(self, pred: Any) -> None:
        self._fail_sets_matching = pred

    async def hget(self, key: str, field: str) -> str | None:
        self.hget_calls += 1
        if self._fail_next_hget:
            self._fail_next_hget = False
            raise Exception('NOAUTH ACL denied')
        return self.hashes.get(key, {}).get(field)

    async def hset(self, key: str, field: str, value: str) -> int:
        self.hset_calls += 1
        if self._fail_next_hset:
            self._fail_next_hset = False
            raise Exception('NOAUTH ACL denied')
        existed = field in self.hashes.get(key, {})
        self.hashes.setdefault(key, {})[field] = value
        return 0 if existed else 1

    async def set(self, key: str, value: str, *args: Any) -> str | None:
        call: dict[str, Any] = {'key': key, 'value': value, 'args': list(args)}
        self.set_calls.append(call)
        if self._fail_sets_matching and self._fail_sets_matching(key, args):
            raise Exception('NOAUTH ACL denied')
        has_nx = 'NX' in args
        if has_nx and key in self.strings:
            return None
        ex_index = list(args).index('EX') if 'EX' in args else -1
        expires_at = None
        if ex_index >= 0:
            ttl = args[ex_index + 1]
            import time
            expires_at = time.time() + ttl
        self.strings[key] = {'value': value, 'expires_at': expires_at}
        return 'OK'

    async def delete(self, *keys: str) -> int:
        n = 0
        for key in keys:
            self.del_calls.append(key)
            if key in self.strings:
                del self.strings[key]
                n += 1
        return n


def _base_input(name: str = 'foo', **kwargs: Any) -> BuildSemanticMetadataInput:
    return BuildSemanticMetadataInput(
        name=name,
        version='0.2.0',
        default_threshold=0.1,
        category_thresholds={},
        uncertainty_band=0.05,
        include_categories=True,
        **kwargs,
    )


def _make_manager(
    client: FakeClient,
    name: str = 'foo',
    on_write_failed: Any = None,
    logger: Any = None,
    heartbeat_interval_s: float = 999_999.0,
) -> DiscoveryManager:
    meta_input = _base_input(name)
    return DiscoveryManager(
        client=client,
        name=name,
        build_metadata=lambda: build_semantic_metadata(meta_input),
        heartbeat_interval_s=heartbeat_interval_s,
        logger=logger,
        on_write_failed=on_write_failed,
    )


# ---------------------------------------------------------------------------
# build_semantic_metadata
# ---------------------------------------------------------------------------

class TestBuildSemanticMetadata:
    def test_capabilities_include_all_three(self) -> None:
        meta = build_semantic_metadata(_base_input())
        assert set(meta['capabilities']) == {
            'invalidate',
            'similarity_distribution',
            'threshold_adjust',
        }
        assert len(meta['capabilities']) == 3

    def test_type_is_semantic_cache(self) -> None:
        meta = build_semantic_metadata(_base_input())
        assert meta['type'] == 'semantic_cache'

    def test_derives_index_stats_config_keys(self) -> None:
        meta = build_semantic_metadata(_base_input('faq-cache'))
        assert meta['index_name'] == 'faq-cache:idx'
        assert meta['stats_key'] == 'faq-cache:__stats'
        assert meta['config_key'] == 'faq-cache:__config'

    def test_omits_category_thresholds_when_include_categories_false(self) -> None:
        meta = build_semantic_metadata(
            BuildSemanticMetadataInput(
                name='foo',
                version='0.2.0',
                default_threshold=0.1,
                category_thresholds={'faq': 0.08},
                uncertainty_band=0.05,
                include_categories=False,
            )
        )
        assert 'category_thresholds' not in meta

    def test_omits_category_thresholds_when_empty_even_if_include_categories_true(self) -> None:
        meta = build_semantic_metadata(
            BuildSemanticMetadataInput(
                name='foo',
                version='0.2.0',
                default_threshold=0.1,
                category_thresholds={},
                uncertainty_band=0.05,
                include_categories=True,
            )
        )
        assert 'category_thresholds' not in meta

    def test_includes_category_thresholds_when_present_and_enabled(self) -> None:
        thresholds = {'faq': 0.08, 'support': 0.12}
        meta = build_semantic_metadata(
            BuildSemanticMetadataInput(
                name='foo',
                version='0.2.0',
                default_threshold=0.1,
                category_thresholds=thresholds,
                uncertainty_band=0.05,
                include_categories=True,
            )
        )
        assert meta['category_thresholds'] == thresholds

    def test_includes_pid_and_hostname(self) -> None:
        import os
        import socket
        meta = build_semantic_metadata(_base_input())
        assert meta['pid'] == os.getpid()
        assert meta['hostname'] == socket.gethostname()

    def test_started_at_is_iso8601(self) -> None:
        from datetime import datetime
        meta = build_semantic_metadata(_base_input())
        # Must not raise
        dt = datetime.fromisoformat(meta['started_at'])
        assert dt is not None

    def test_protocol_version(self) -> None:
        meta = build_semantic_metadata(_base_input())
        assert meta['protocol_version'] == PROTOCOL_VERSION


# ---------------------------------------------------------------------------
# DiscoveryManager.register
# ---------------------------------------------------------------------------

class TestDiscoveryManagerRegister:
    @pytest.mark.asyncio
    async def test_writes_registry_hash_and_protocol_key(self) -> None:
        client = FakeClient()
        mgr = _make_manager(client)

        await mgr.register()

        entry = client.hashes.get(REGISTRY_KEY, {}).get('foo')
        assert entry is not None
        parsed = json.loads(entry)
        assert parsed['type'] == 'semantic_cache'
        assert parsed['prefix'] == 'foo'
        assert parsed['protocol_version'] == PROTOCOL_VERSION

        protocol_call = next(
            (c for c in client.set_calls if c['key'] == PROTOCOL_KEY), None
        )
        assert protocol_call is not None
        assert 'NX' in protocol_call['args']

        await mgr.stop(delete_heartbeat=True)

    @pytest.mark.asyncio
    async def test_throws_on_cross_type_collision(self) -> None:
        client = FakeClient()
        bad_meta = build_semantic_metadata(_base_input())
        bad_meta['type'] = 'agent_cache'
        client.hashes[REGISTRY_KEY] = {'foo': json.dumps(bad_meta)}
        original_entry = client.hashes[REGISTRY_KEY]['foo']

        on_failed = MagicMock()
        mgr = _make_manager(client, on_write_failed=on_failed)

        with pytest.raises(SemanticCacheUsageError, match='agent_cache'):
            await mgr.register()

        # Registry must not have been overwritten
        assert client.hashes[REGISTRY_KEY]['foo'] == original_entry

    @pytest.mark.asyncio
    async def test_overwrites_with_warning_on_same_type_version_mismatch(self) -> None:
        client = FakeClient()
        old_meta = build_semantic_metadata(_base_input())
        old_meta['version'] = '0.1.99'
        client.hashes[REGISTRY_KEY] = {'foo': json.dumps(old_meta)}

        logger = MagicMock()
        mgr = DiscoveryManager(
            client=client,
            name='foo',
            build_metadata=lambda: build_semantic_metadata(_base_input()),
            heartbeat_interval_s=999_999.0,
            logger=logger,
        )

        await mgr.register()

        logger.warning.assert_called_once()
        assert 'overwriting marker' in logger.warning.call_args[0][0]
        parsed = json.loads(client.hashes[REGISTRY_KEY]['foo'])
        assert parsed['version'] == '0.2.0'

        await mgr.stop(delete_heartbeat=True)

    @pytest.mark.asyncio
    async def test_does_not_raise_when_hset_fails(self) -> None:
        client = FakeClient()
        client.fail_hset_once()
        on_failed = MagicMock()
        mgr = _make_manager(client, on_write_failed=on_failed)

        # Should not raise
        await mgr.register()
        on_failed.assert_called()

        await mgr.stop(delete_heartbeat=True)

    @pytest.mark.asyncio
    async def test_does_not_raise_when_hget_fails_collision_check_skipped(self) -> None:
        client = FakeClient()
        client.fail_hget_once()
        on_failed = MagicMock()
        mgr = _make_manager(client, on_write_failed=on_failed)

        await mgr.register()
        on_failed.assert_called()
        # HSET still ran after HGET failure
        assert client.hset_calls == 1

        await mgr.stop(delete_heartbeat=True)

    @pytest.mark.asyncio
    async def test_writes_initial_heartbeat_during_register(self) -> None:
        client = FakeClient()
        mgr = _make_manager(client)

        await mgr.register()

        heartbeat_key = f'{HEARTBEAT_KEY_PREFIX}foo'
        assert heartbeat_key in client.strings
        assert client.strings[heartbeat_key]['expires_at'] is not None

        await mgr.stop(delete_heartbeat=True)


# ---------------------------------------------------------------------------
# DiscoveryManager heartbeat
# ---------------------------------------------------------------------------

class TestDiscoveryManagerHeartbeat:
    @pytest.mark.asyncio
    async def test_tick_heartbeat_writes_key_with_60s_ttl(self) -> None:
        client = FakeClient()
        mgr = _make_manager(client)

        await mgr.tick_heartbeat()

        heartbeat_calls = [
            c for c in client.set_calls if c['key'] == f'{HEARTBEAT_KEY_PREFIX}foo'
        ]
        assert heartbeat_calls, 'No heartbeat SET call found'
        call = heartbeat_calls[-1]
        args = call['args']
        ex_index = args.index('EX') if 'EX' in args else -1
        assert ex_index >= 0
        assert args[ex_index + 1] == HEARTBEAT_TTL_SECONDS
        # Value must be an ISO 8601 date string
        from datetime import datetime
        datetime.fromisoformat(call['value'])  # must not raise

    @pytest.mark.asyncio
    async def test_stop_delete_heartbeat_true_deletes_key(self) -> None:
        client = FakeClient()
        mgr = _make_manager(client)

        await mgr.register()
        await mgr.tick_heartbeat()
        await mgr.stop(delete_heartbeat=True)

        assert f'{HEARTBEAT_KEY_PREFIX}foo' in client.del_calls

    @pytest.mark.asyncio
    async def test_stop_delete_heartbeat_false_leaves_key(self) -> None:
        client = FakeClient()
        mgr = _make_manager(client)

        await mgr.register()
        await mgr.stop(delete_heartbeat=False)

        assert len(client.del_calls) == 0

    @pytest.mark.asyncio
    async def test_tick_heartbeat_failure_calls_on_write_failed(self) -> None:
        client = FakeClient()
        heartbeat_key = f'{HEARTBEAT_KEY_PREFIX}foo'
        client.fail_sets_matching_predicate(lambda key, args: key == heartbeat_key)
        on_failed = MagicMock()
        mgr = _make_manager(client, on_write_failed=on_failed)

        await mgr.tick_heartbeat()

        on_failed.assert_called()

    @pytest.mark.asyncio
    async def test_stop_does_not_touch_registry_hash(self) -> None:
        client = FakeClient()
        mgr = _make_manager(client)

        await mgr.register()
        before = client.hashes.get(REGISTRY_KEY, {}).get('foo')

        await mgr.stop(delete_heartbeat=True)

        assert client.hashes.get(REGISTRY_KEY, {}).get('foo') == before

    @pytest.mark.asyncio
    async def test_heartbeat_loop_fires_after_interval(self) -> None:
        """Heartbeat loop eventually calls tick_heartbeat when interval elapses."""
        client = FakeClient()
        mgr = DiscoveryManager(
            client=client,
            name='foo',
            build_metadata=lambda: build_semantic_metadata(_base_input()),
            heartbeat_interval_s=0.01,  # very short for test speed
        )

        await mgr.register()
        initial_set_count = len(client.set_calls)

        # Give the loop a chance to fire at least once
        await asyncio.sleep(0.05)

        await mgr.stop(delete_heartbeat=True)

        # At least one additional heartbeat tick should have occurred
        assert len(client.set_calls) > initial_set_count
