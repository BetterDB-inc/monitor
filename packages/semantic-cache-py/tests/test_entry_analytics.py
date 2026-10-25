"""Unit tests for per-entry hit tracking and entry_analytics()."""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from betterdb_semantic_cache import (
    DiscoveryOptions,
    EntryAnalyticsOptions,
    EntryAnalyticsResult,
    SemanticCache,
    SemanticCacheOptions,
    TelemetryOptions,
    UsageTrackingOptions,
)
from betterdb_semantic_cache.semantic_cache import (
    ALL_ENTRIES_QUERY,
    HIT_AT_LEAST_ONCE_QUERY,
    RECORD_USAGE_SHA,
)

from .conftest import _ft_info_response, make_client, make_telemetry


def _make_analytics_cache(
    *,
    search_result: dict | None = None,
    default_ttl: int | None = None,
    usage_tracking_enabled: bool = True,
    has_usage_fields: bool = True,
) -> tuple[SemanticCache, MagicMock]:
    client = make_client(search_result=search_result)
    embed_fn = AsyncMock(return_value=[0.5, 0.5])

    # Override FT.INFO response to configure whether usage fields exist
    def _execute_command(*args):
        cmd = args[0] if args else ""
        if cmd == "FT.INFO":
            return _ft_info_response(2, has_usage_fields=has_usage_fields)
        if cmd in ("FT.CREATE", "FT.DROPINDEX"):
            return "OK"
        if cmd == "FT.SEARCH":
            if search_result:
                fields = {**search_result.get("fields", {}), "__score": "0.01"}
                flat = []
                for k, v in fields.items():
                    flat.extend([k, str(v)])
                return ["1", search_result["key"], flat]
            return ["0"]
        return None

    client.execute_command = AsyncMock(side_effect=_execute_command)

    opts = SemanticCacheOptions(
        client=client,
        embed_fn=embed_fn,
        name="test_analytics",
        default_ttl=default_ttl,
        discovery=DiscoveryOptions(enabled=False),
        telemetry=TelemetryOptions(tracer_name="test", metrics_prefix="test_sc"),
        usage_tracking=UsageTrackingOptions(enabled=usage_tracking_enabled),
    )
    cache = SemanticCache(opts)
    cache._telemetry = make_telemetry()
    return cache, client


# ── Store field initialization ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_store_initializes_hit_count_and_last_accessed_at():
    cache, client = _make_analytics_cache()
    await cache.initialize()

    await cache.store("prompt", "response")
    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert mapping["hit_count"] == "0"
    assert mapping["last_accessed_at"] == "0"


@pytest.mark.asyncio
async def test_store_multipart_initializes_hit_count_and_last_accessed_at():
    cache, client = _make_analytics_cache()
    await cache.initialize()

    await cache.store_multipart("prompt", [{"type": "text", "text": "response"}])
    mapping = client.hset.call_args.kwargs.get("mapping") or client.hset.call_args.args[1]
    assert mapping["hit_count"] == "0"
    assert mapping["last_accessed_at"] == "0"


# ── FT.CREATE schema fields ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ft_create_includes_usage_fields():
    client = make_client()
    # Simulate fresh index creation: FT.INFO throws "no such index"

    def _execute_command(*args):
        cmd = args[0] if args else ""
        if cmd == "FT.INFO":
            raise Exception("no such index")
        if cmd == "FT.CREATE":
            return "OK"
        return None

    client.execute_command = AsyncMock(side_effect=_execute_command)
    cache = SemanticCache(
        SemanticCacheOptions(
            client=client,
            embed_fn=AsyncMock(return_value=[0.1, 0.2]),
            name="new_idx",
            discovery=DiscoveryOptions(enabled=False),
            telemetry=TelemetryOptions(tracer_name="test", metrics_prefix="test_sc"),
        )
    )
    cache._telemetry = make_telemetry()
    await cache.initialize()

    # Verify FT.CREATE was called with hit_count and last_accessed_at
    create_call = [c for c in client.execute_command.call_args_list if c.args[0] == "FT.CREATE"][0]
    args = list(create_call.args)
    assert "hit_count" in args
    assert "last_accessed_at" in args
    idx_hc = args.index("hit_count")
    assert args[idx_hc + 1 : idx_hc + 3] == ["NUMERIC", "SORTABLE"]
    idx_la = args.index("last_accessed_at")
    assert args[idx_la + 1 : idx_la + 3] == ["NUMERIC", "SORTABLE"]
    assert cache._has_usage_fields is True


# ── Hit path usage tracking ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_check_triggers_fire_and_forget_usage_write():
    cache, client = _make_analytics_cache(
        search_result={"key": "test_analytics:entry:k1", "fields": {"response": "res"}},
        default_ttl=3600,
    )
    await cache.initialize()

    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[1])

    res = await cache.check("prompt")
    assert res.hit is True

    # Await background drain
    await cache._drain_usage_writes()

    # Verify pipeline was called with EVALSHA and RECORD_USAGE_SHA
    exec_call = pipe.execute_command.call_args
    assert exec_call.args[0] == "EVALSHA"
    assert exec_call.args[1] == RECORD_USAGE_SHA
    assert exec_call.args[2] == "1"
    assert exec_call.args[3] == "test_analytics:entry:k1"
    assert exec_call.args[5] == "3600"


@pytest.mark.asyncio
async def test_noscript_retries_with_eval():
    cache, client = _make_analytics_cache(
        search_result={"key": "test_analytics:entry:k1", "fields": {"response": "res"}},
    )
    await cache.initialize()

    pipe = client.pipeline()
    # When EVALSHA is sent, return NOSCRIPT exception; when EVAL is sent, return 1
    async def _pipe_execute(*args, **kwargs):
        last_cmd = pipe.execute_command.call_args.args[0] if pipe.execute_command.call_args else ""
        if last_cmd == "EVALSHA":
            return [Exception("NOSCRIPT No matching script. Please use EVAL.")]
        return [1]

    pipe.execute = AsyncMock(side_effect=_pipe_execute)

    res = await cache.check("prompt")
    assert res.hit is True

    await cache._drain_usage_writes()

    # Verify EVALSHA was called first, then retried with EVAL
    eval_cmds = [
        c.args[0] for c in pipe.execute_command.call_args_list if c.args and c.args[0] in ("EVALSHA", "EVAL")
    ]
    assert eval_cmds == ["EVALSHA", "EVAL"]


@pytest.mark.asyncio
async def test_check_opt_out_uses_plain_expire():
    cache, client = _make_analytics_cache(
        search_result={"key": "test_analytics:entry:k1", "fields": {"response": "res"}},
        default_ttl=3600,
        usage_tracking_enabled=False,
    )
    await cache.initialize()

    pipe = client.pipeline()
    pipe.execute_command = MagicMock()

    res = await cache.check("prompt")
    assert res.hit is True

    # When disabled, no background task or EVALSHA is sent; client.expire is called directly
    assert pipe.execute_command.call_count == 0
    client.expire.assert_awaited_with("test_analytics:entry:k1", 3600)


@pytest.mark.asyncio
async def test_check_opt_out_without_default_ttl_does_no_write():
    cache, client = _make_analytics_cache(
        search_result={"key": "test_analytics:entry:k1", "fields": {"response": "res"}},
        default_ttl=None,
        usage_tracking_enabled=False,
    )
    await cache.initialize()

    pipe = client.pipeline()
    pipe.execute_command = MagicMock()

    res = await cache.check("prompt")
    assert res.hit is True

    assert pipe.execute_command.call_count == 0
    client.expire.assert_not_called()


# ── Option Validation ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_entry_analytics_option_validation():
    cache, _ = _make_analytics_cache()
    await cache.initialize()

    # Invalid top_n
    with pytest.raises(ValueError, match="top_n must be an integer in"):
        await cache.entry_analytics(EntryAnalyticsOptions(top_n=-1))

    with pytest.raises(ValueError, match="top_n must be an integer in"):
        await cache.entry_analytics(EntryAnalyticsOptions(top_n=10001))

    with pytest.raises(ValueError, match="top_n must be an integer in"):
        await cache.entry_analytics(EntryAnalyticsOptions(top_n="5"))  # type: ignore

    with pytest.raises(ValueError, match="top_n must be an integer in"):
        await cache.entry_analytics(EntryAnalyticsOptions(top_n=True))  # type: ignore

    # Invalid cold_after_days
    with pytest.raises(ValueError, match="cold_after_days must be a non-negative number"):
        await cache.entry_analytics(EntryAnalyticsOptions(cold_after_days=-0.5))

    with pytest.raises(ValueError, match="cold_after_days must be a non-negative number"):
        await cache.entry_analytics(EntryAnalyticsOptions(cold_after_days=float("nan")))

    with pytest.raises(ValueError, match="cold_after_days must be a non-negative number"):
        await cache.entry_analytics(EntryAnalyticsOptions(cold_after_days=float("inf")))

    with pytest.raises(ValueError, match="cold_after_days must be a non-negative number"):
        await cache.entry_analytics(EntryAnalyticsOptions(cold_after_days=True))  # type: ignore


# ── Fast Search Path ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_entry_analytics_fast_search_path():
    cache, client = _make_analytics_cache(has_usage_fields=True)
    await cache.initialize()

    # Mock FT.SEARCH queries
    def _execute_command(*args):
        cmd = args[0] if args else ""
        if cmd == "FT.INFO":
            return _ft_info_response(2, has_usage_fields=True)
        if cmd == "FT.SEARCH":
            query = args[2]
            if query == ALL_ENTRIES_QUERY:
                return ["100"]  # 100 total entries
            if query == HIT_AT_LEAST_ONCE_QUERY:
                if "SORTBY" in args:
                    # Top entries return
                    return [
                        "2",
                        "test_analytics:entry:h1",
                        ["hit_count", "15", "last_accessed_at", "1700000000000", "inserted_at", "1690000000000", "category", "catA", "model", "gpt-4"],
                        "test_analytics:entry:h2",
                        ["hit_count", "8", "last_accessed_at", "1700000005000", "inserted_at", "1690000001000", "category", "catB", "model", "claude-3"],
                    ]
                return ["30"]  # 30 entries hit at least once
            if query.startswith("@last_accessed_at:"):
                return ["25"]  # 25 warm entries (accessed >= cutoff)
            return ["0"]
        return None

    client.execute_command = AsyncMock(side_effect=_execute_command)

    result = await cache.entry_analytics(EntryAnalyticsOptions(top_n=5, cold_after_days=7.0))

    assert isinstance(result, EntryAnalyticsResult)
    assert result.total_entries == 100
    assert result.hit_at_least_once_count == 30
    assert result.never_hit_count == 70  # 100 - 30
    assert result.cold_entry_count == 75  # 100 - 25
    assert result.cold_after_days == 7.0
    assert result.sampled is False

    assert len(result.top_entries) == 2
    top1 = result.top_entries[0]
    assert top1.key == "test_analytics:entry:h1"
    assert top1.hit_count == 15
    assert top1.last_accessed_at == 1700000000000
    assert top1.category == "catA"
    assert top1.model == "gpt-4"

    top2 = result.top_entries[1]
    assert top2.key == "test_analytics:entry:h2"
    assert top2.hit_count == 8
    assert top2.category == "catB"


@pytest.mark.asyncio
async def test_entry_analytics_top_n_zero_skips_sortby():
    cache, client = _make_analytics_cache(has_usage_fields=True)
    await cache.initialize()

    executed_queries = []

    def _execute_command(*args):
        cmd = args[0] if args else ""
        if cmd == "FT.INFO":
            return _ft_info_response(2, has_usage_fields=True)
        if cmd == "FT.SEARCH":
            executed_queries.append(args)
            return ["50"]
        return None

    client.execute_command = AsyncMock(side_effect=_execute_command)

    result = await cache.entry_analytics(EntryAnalyticsOptions(top_n=0))
    assert result.total_entries == 50
    assert result.top_entries == []
    # Verify no query had SORTBY
    assert not any("SORTBY" in q for q in executed_queries)


# ── SCAN Fallback Path ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_entry_analytics_scan_fallback_when_usage_fields_missing():
    cache, client = _make_analytics_cache(has_usage_fields=False)
    await cache.initialize()
    assert cache._has_usage_fields is False

    # Mock SCAN returning keys
    client.scan = AsyncMock(
        side_effect=[
            (1, [b"test_analytics:entry:1", b"test_analytics:entry:2", b"test_analytics:entry:3"]),
            (0, []),
        ]
    )

    now_ms = int(time.time() * 1000)
    old_ms = now_ms - 10 * 86400 * 1000  # 10 days ago (cold)
    recent_ms = now_ms - 2 * 86400 * 1000  # 2 days ago (warm)

    pipe = client.pipeline()
    pipe.execute = AsyncMock(
        return_value=[
            [b"5", str(recent_ms).encode(), b"1000", b"cat1", b"model1"],  # Hit and warm
            [b"2", str(old_ms).encode(), b"1000", b"cat2", b"model2"],     # Hit but cold
            [b"0", b"0", b"1000", b"cat3", b"model3"],                     # Never hit (cold)
        ]
    )

    result = await cache.entry_analytics(EntryAnalyticsOptions(top_n=5, cold_after_days=7.0))

    assert result.total_entries == 3
    assert result.hit_at_least_once_count == 2
    assert result.never_hit_count == 1
    assert result.cold_entry_count == 2  # old_ms + never hit
    assert result.sampled is False
    assert len(result.top_entries) == 2
    assert result.top_entries[0].hit_count == 5
    assert result.top_entries[1].hit_count == 2


@pytest.mark.asyncio
async def test_entry_analytics_falls_back_to_scan_on_ft_search_error():
    cache, client = _make_analytics_cache(has_usage_fields=True)
    await cache.initialize()

    # FT.SEARCH raises, triggering fallback to SCAN
    def _execute_command(*args):
        cmd = args[0] if args else ""
        if cmd == "FT.INFO":
            return _ft_info_response(2, has_usage_fields=True)
        if cmd == "FT.SEARCH":
            raise Exception("Search index corrupted or missing")
        return None

    client.execute_command = AsyncMock(side_effect=_execute_command)
    client.scan = AsyncMock(side_effect=[(0, [b"test_analytics:entry:1"])])

    pipe = client.pipeline()
    pipe.execute = AsyncMock(return_value=[[b"3", b"1700000000000", b"1000", b"", b""]])

    # Logger warning should be emitted
    mock_logger = MagicMock()
    cache._logger = mock_logger

    result = await cache.entry_analytics(EntryAnalyticsOptions(top_n=5))

    assert result.total_entries == 1
    assert result.hit_at_least_once_count == 1
    assert mock_logger.warning.call_count == 1
    warn_text = mock_logger.warning.call_args[0][0]
    assert "FT.SEARCH failed, falling back to sampled SCAN" in warn_text
