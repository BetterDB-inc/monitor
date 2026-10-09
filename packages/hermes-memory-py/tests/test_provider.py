"""Unit tests: provider construction, availability, and the recall/remember mapping.

The SDK client is mocked end-to-end (``FakeStore`` + ``FakeRuntime``), so nothing
here needs a live Valkey or an embeddings endpoint.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import time
from concurrent.futures import Future
from dataclasses import dataclass
from typing import List

import pytest

import betterdb_hermes_memory as provider_mod
from betterdb_hermes_memory import (
    RECALL_K,
    BetterDBMemoryProvider,
    _Config,
    _tls_url,
    register,
)
from betterdb_hermes_memory.embeddings import EmbeddingConfig, build_http_embed_fn
from betterdb_hermes_memory.runtime import LoopRuntime


# --------------------------------------------------------------------------- #
# Test doubles
# --------------------------------------------------------------------------- #

@dataclass
class FakeItem:
    id: str
    content: str
    agent_id: str = "hermes"
    namespace: str | None = None


@dataclass
class FakeHit:
    item: FakeItem
    score: float = 0.9
    similarity: float = 0.1


_UNSET = object()


class FakeStore:
    def __init__(
        self,
        hits: List[FakeHit] | None = None,
        remember_error: Exception | None = None,
        get_item=_UNSET,
    ):
        self._hits = hits or []
        self._remember_error = remember_error
        # What get(id) returns: by default an item in the provider's own scope (so
        # forget succeeds); pass None to simulate not-found, or a foreign-scope item.
        self._get_item = get_item
        self.remembered: list = []
        self.recalled: list = []
        self.forgotten: list = []
        self.index_ready = False
        self.discovery_ready = False
        self.closed = False

    async def ensure_index(self) -> None:
        self.index_ready = True

    async def get(self, id):
        if self._get_item is _UNSET:
            return FakeItem(id=id, content="x", agent_id="hermes", namespace=None)
        return self._get_item

    async def ensure_discovery_ready(self) -> None:
        self.discovery_ready = True

    async def recall(self, query, *, k=None, agent_id=None, thread_id=None, namespace=None, **kw):
        self.recalled.append({"query": query, "k": k, "agent_id": agent_id, "namespace": namespace})
        return self._hits

    async def remember(self, content, *, importance=None, tags=None, source=None,
                       agent_id=None, thread_id=None, namespace=None, **kw):
        if self._remember_error is not None:
            raise self._remember_error
        self.remembered.append({
            "content": content, "importance": importance, "tags": tags,
            "source": source, "agent_id": agent_id, "thread_id": thread_id,
            "namespace": namespace,
        })
        return "mem-1"

    async def forget(self, id) -> bool:
        self.forgotten.append(id)
        return True

    async def close(self) -> None:
        self.closed = True


class FakeRuntime:
    """Runs submitted coroutines synchronously so assertions see finished state."""

    def __init__(self):
        self.started = False
        self.stopped = False

    def start(self) -> None:
        self.started = True

    def _drive(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    def submit(self, coro) -> "Future":
        fut: Future = Future()
        try:
            fut.set_result(self._drive(coro))
        except Exception as exc:  # noqa: BLE001
            fut.set_exception(exc)
        return fut

    def run(self, coro, *, timeout=None):
        return self._drive(coro)

    def stop(self, *, timeout=5.0, drain=True) -> None:
        self.stopped = True


def _wired(store: FakeStore | None = None, *, initialize: bool = True, **cfg):
    store = store if store is not None else FakeStore()
    provider = BetterDBMemoryProvider(
        # An explicit host makes the wired provider genuinely "configured" (the bare
        # 127.0.0.1 default no longer counts — see has_connection meaningfulness).
        config={"host": "127.0.0.1", **cfg},
        store=store,
        runtime=FakeRuntime(),
        embed_fn=lambda text: None,  # presence satisfies is_available; never called here
    )
    if initialize:
        # Run the real lifecycle so self._config is resolved live, exactly as Hermes
        # drives it; config is no longer frozen at construction.
        provider.initialize("s1", agent_id="hermes")
    return provider, store


# --------------------------------------------------------------------------- #
# Availability
# --------------------------------------------------------------------------- #

def test_embedding_config_readiness():
    assert EmbeddingConfig().is_configured() is False  # default hosted endpoint, no key
    assert EmbeddingConfig(api_key="sk-x").is_configured() is True
    assert EmbeddingConfig(base_url="http://localhost:11434/v1").is_configured() is True


def test_embedding_is_insecure():
    # https is always fine (keyed or not).
    assert EmbeddingConfig(base_url="https://x/v1", api_key="k").is_insecure() is False
    assert EmbeddingConfig(base_url="https://embeddings.example.com/v1").is_insecure() is False
    # Plaintext http:// to a remote/public host leaks the input — insecure whether
    # a key is set (credential + text) or keyless (text alone still leaks).
    assert EmbeddingConfig(base_url="http://x/v1", api_key="k").is_insecure() is True
    assert EmbeddingConfig(base_url="http://embeddings.example.com/v1").is_insecure() is True
    assert EmbeddingConfig(base_url="http://embeddings.example.com/v1", api_key="k").is_insecure() is True
    # Plaintext http:// to a local host stays on the machine/LAN — fine, keyed or not.
    assert EmbeddingConfig(base_url="http://localhost:11434/v1").is_insecure() is False
    assert EmbeddingConfig(base_url="http://localhost:11434/v1", api_key="k").is_insecure() is False
    assert EmbeddingConfig(base_url="http://127.0.0.1:11434/v1").is_insecure() is False
    assert EmbeddingConfig(base_url="http://[::1]:11434/v1").is_insecure() is False
    assert EmbeddingConfig(base_url="http://10.1.2.3:8000/v1").is_insecure() is False
    assert EmbeddingConfig(base_url="http://172.16.0.9:8000/v1").is_insecure() is False
    assert EmbeddingConfig(base_url="http://192.168.1.5:8000/v1").is_insecure() is False
    assert EmbeddingConfig(base_url="http://ollama.internal/v1").is_insecure() is False
    assert EmbeddingConfig(base_url="http://box.local/v1").is_insecure() is False


def test_http_embedder_refuses_api_key_over_plaintext():
    embedder = build_http_embed_fn(EmbeddingConfig(base_url="http://x/v1", api_key="k"))
    with pytest.raises(RuntimeError, match="plaintext"):
        asyncio.run(embedder("hello"))  # fails before any network call


def test_build_client_unix_tls_fails_closed():
    # tls can't be applied to unix:// — refuse rather than connect in cleartext.
    provider, _ = _wired(url="unix:///run/valkey.sock", tls=True)
    with pytest.raises(ValueError, match="cannot be upgraded to TLS"):
        provider._build_client()


def test_on_session_switch_adopts_session_and_clears_cache():
    provider, _ = _wired()
    provider._session_id = "old"
    with provider._lock:
        provider._recall_block = "## BetterDB Memory\n- x"
        provider._recall_count = 1
        provider._recall_session = "old"
    provider.on_session_switch("new")
    assert provider._session_id == "new"
    assert provider._recall_block == ""
    assert provider._recall_session == ""


def test_prefetch_drops_block_from_another_session():
    provider, _ = _wired()

    def cache_for(sid):
        with provider._lock:
            provider._recall_block = "## BetterDB Memory\n- x"
            provider._recall_count = 1
            provider._recall_session = sid

    cache_for("sessionA")
    assert provider.prefetch("q", session_id="sessionB") == ""  # not this chat's block
    cache_for("sessionA")
    assert provider.prefetch("q", session_id="sessionA").startswith("## BetterDB Memory")


def test_is_available_true_with_embed_fn():
    provider, _ = _wired()
    # Explicit host connection + injected embed_fn + SDK importable -> available.
    assert provider.is_available() is True


def test_is_available_false_without_embeddings():
    # Host configured but no embeddings -> unavailable, and the reason names embeddings.
    provider = BetterDBMemoryProvider(config={"host": "127.0.0.1"})
    assert provider.is_available() is False
    assert "embeddings" in provider.unavailable_reason().lower()


def test_has_connection_meaningful_when_unconfigured():
    # No url and no explicit host/port: the silent 127.0.0.1 default must NOT count
    # as configured, so the provider is unavailable with the real "no Valkey" reason.
    provider = BetterDBMemoryProvider(config={}, embed_fn=lambda text: None)
    assert provider.is_available() is False
    assert "no valkey" in provider.unavailable_reason().lower()

    # An explicit host flips it: now a connection is configured.
    configured = BetterDBMemoryProvider(config={"host": "db.internal"}, embed_fn=lambda text: None)
    assert configured.is_available() is True


def test_name():
    provider, _ = _wired()
    assert provider.name == "betterdb"


def test_is_available_false_when_secret_lookup_raises(monkeypatch):
    # If resolving config/secrets raises in the active scope (e.g. an unresolved
    # profile secret), availability must fail closed — never propagate the error.
    def _boom(name, default=""):
        raise RuntimeError("no active profile scope")

    monkeypatch.setattr(provider_mod, "_get_secret", _boom)
    provider = BetterDBMemoryProvider(config={"host": "db.internal"}, embed_fn=lambda text: None)
    assert provider.is_available() is False
    reason = provider.unavailable_reason()
    assert reason and "could not be resolved" in reason.lower()


# --------------------------------------------------------------------------- #
# TLS via URL scheme (ssl= kwarg would crash from_url)
# --------------------------------------------------------------------------- #

def test_tls_url_upgrades_scheme():
    assert _tls_url("valkey://host:6379/0") == "valkeys://host:6379/0"
    assert _tls_url("redis://host:6379") == "rediss://host:6379"
    # Already-secure schemes are untouched.
    assert _tls_url("valkeys://host:6379") == "valkeys://host:6379"
    assert _tls_url("rediss://host:6379") == "rediss://host:6379"
    # A string without a scheme is returned unchanged.
    assert _tls_url("host:6379") == "host:6379"


def test_build_client_url_tls_selects_ssl_without_crash():
    # tls=true + url must NOT pass ssl= to from_url (valkey-py rejects it); TLS is
    # expressed through the upgraded scheme, which selects the SSL connection class.
    provider = BetterDBMemoryProvider(config={})
    provider._config = _Config({"url": "valkey://localhost:6379/0", "tls": True})
    client = provider._build_client()  # must not raise
    assert client.connection_pool.connection_class.__name__ == "SSLConnection"


def test_build_client_url_without_tls_is_plaintext():
    provider = BetterDBMemoryProvider(config={})
    provider._config = _Config({"url": "valkey://localhost:6379/0", "tls": False})
    client = provider._build_client()
    assert client.connection_pool.connection_class.__name__ == "Connection"


# --------------------------------------------------------------------------- #
# recall -> prefetch
# --------------------------------------------------------------------------- #

def test_recall_maps_to_prefetch_block():
    store = FakeStore(hits=[FakeHit(FakeItem("1", "likes dark mode")),
                            FakeHit(FakeItem("2", "prefers concise answers"))])
    provider, store = _wired(store)

    provider.queue_prefetch("what does the user like?", session_id="s1")
    block = provider.prefetch("what does the user like?", session_id="s1")

    assert store.recalled[0]["query"] == "what does the user like?"
    assert store.recalled[0]["k"] == RECALL_K
    assert store.recalled[0]["agent_id"] == "hermes"
    assert "likes dark mode" in block and "prefers concise answers" in block
    assert block.startswith("## BetterDB Memory")

    status = provider.recall_status()
    assert status is not None and status.count == 2

    # prefetch clears the cache: a second read returns nothing.
    assert provider.prefetch("x") == ""
    assert provider.recall_status() is None


def test_empty_query_skips_recall():
    provider, store = _wired()
    provider.queue_prefetch("   ")
    assert store.recalled == []
    assert provider.prefetch("   ") == ""


# --------------------------------------------------------------------------- #
# remember -> sync_turn / on_memory_write
# --------------------------------------------------------------------------- #

def test_sync_turn_persists_turn():
    provider, store = _wired()
    provider.sync_turn("I live in Berlin", "Noted.", session_id="s1")

    assert len(store.remembered) == 1
    rec = store.remembered[0]
    assert "User: I live in Berlin" in rec["content"]
    assert "Assistant: Noted." in rec["content"]
    assert rec["source"] == "turn"
    assert rec["thread_id"] == "s1"


def test_sync_turn_skipped_for_non_primary_context():
    provider, store = _wired()
    provider._agent_context = "subagent"
    provider.sync_turn("hello", "hi", session_id="s1")
    assert store.remembered == []


def test_on_memory_write_mirrors_user_write():
    provider, store = _wired()
    provider.on_memory_write("add", "user", "User prefers metric units")
    assert len(store.remembered) == 1
    assert store.remembered[0]["source"] == "user"
    assert store.remembered[0]["importance"] == 0.8

    # Non-add actions are ignored.
    provider.on_memory_write("remove", "memory", "stale")
    assert len(store.remembered) == 1


# --------------------------------------------------------------------------- #
# Explicit tools
# --------------------------------------------------------------------------- #

def test_tool_remember_recall_forget():
    store = FakeStore(hits=[FakeHit(FakeItem("1", "a")), FakeHit(FakeItem("2", "b"))])
    provider, store = _wired(store)

    out = json.loads(provider.handle_tool_call("betterdb_remember", {"content": "remember me"}))
    assert out["id"] == "mem-1" and out["status"] == "remembered"
    assert store.remembered[0]["source"] == "tool"

    out = json.loads(provider.handle_tool_call("betterdb_recall", {"query": "q"}))
    assert out["count"] == 2 and out["results"][0]["content"] == "a"

    out = json.loads(provider.handle_tool_call("betterdb_forget", {"id": "mem-1"}))
    assert out["removed"] is True and store.forgotten == ["mem-1"]


def test_tool_schemas_declared():
    provider, _ = _wired()
    names = {t["name"] for t in provider.get_tool_schemas()}
    assert names == {"betterdb_remember", "betterdb_recall", "betterdb_forget"}


# --------------------------------------------------------------------------- #
# Lifecycle: index + discovery registration
# --------------------------------------------------------------------------- #

def test_initialize_registers_index_and_discovery():
    # discovery is opt-in (default off), so enable it here; initialize() must then
    # create the index AND register discovery, mirroring the SDK facade
    # (ensure_index then ensure_discovery_ready).
    provider, store = _wired(discovery=True)
    assert store.index_ready is True
    assert store.discovery_ready is True


def test_discovery_disabled_skips_registration():
    # discovery=false opts out: the index is still built, but no discovery marker
    # is registered.
    provider, store = _wired(discovery=False)
    assert store.index_ready is True
    assert store.discovery_ready is False
    assert provider._config.discovery is False


# --------------------------------------------------------------------------- #
# Background failures surface (not silent)
# --------------------------------------------------------------------------- #

def test_failed_background_write_logs_warning(caplog):
    store = FakeStore(remember_error=RuntimeError("valkey down"))
    provider, store = _wired(store)
    with caplog.at_level(logging.WARNING, logger="betterdb_hermes_memory"):
        provider.sync_turn("remember this", "ok", session_id="s1")
    assert any("remember" in r.message and "valkey down" in r.message
               for r in caplog.records), caplog.records


# --------------------------------------------------------------------------- #
# importance: safe parse + clamp
# --------------------------------------------------------------------------- #

def test_tool_remember_importance_default_and_clamp():
    def _imp(args):
        store = FakeStore()
        provider, store = _wired(store)
        provider.handle_tool_call("betterdb_remember", {"content": "c", **args})
        return store.remembered[0]["importance"]

    assert _imp({}) == 0.7                      # missing -> default
    assert _imp({"importance": None}) == 0.7     # None -> default
    assert _imp({"importance": "oops"}) == 0.7   # non-numeric -> default
    assert _imp({"importance": "0.3"}) == 0.3    # numeric string parses
    assert _imp({"importance": 5}) == 1.0        # clamp high
    assert _imp({"importance": -2}) == 0.0       # clamp low


# --------------------------------------------------------------------------- #
# Tool timeout surfaces a clear message (not {"error": ""})
# --------------------------------------------------------------------------- #

def test_tool_timeout_message():
    class TimeoutRuntime(FakeRuntime):
        def run(self, coro, *, timeout=None):
            coro.close()  # avoid "coroutine was never awaited" warning
            raise concurrent.futures.TimeoutError()

    store = FakeStore()
    provider = BetterDBMemoryProvider(
        config={"host": "127.0.0.1"}, store=store, runtime=TimeoutRuntime(),
        embed_fn=lambda text: None,
    )
    provider.initialize("s1")
    out = json.loads(provider.handle_tool_call("betterdb_remember", {"content": "x"}))
    assert "timed out" in out["error"].lower()
    assert out["error"] != ""


# --------------------------------------------------------------------------- #
# Shutdown closes the client pool and the embeddings client
# --------------------------------------------------------------------------- #

def test_shutdown_closes_client_store_and_embedder():
    class FakeAsyncClient:
        def __init__(self):
            self.closed = False

        async def aclose(self):
            self.closed = True

    client, embedder = FakeAsyncClient(), FakeAsyncClient()
    store = FakeStore()
    provider, store = _wired(store)
    provider._client = client
    provider._embed_fn = embedder  # stand-in with aclose()
    runtime = provider._runtime

    provider.shutdown()

    assert client.closed is True       # valkey pool released
    assert embedder.closed is True     # embeddings http client released
    assert store.closed is True        # store torn down
    assert runtime.stopped is True     # loop stopped last


def test_shutdown_clears_embedder_so_reinit_rebuilds():
    # aclose() marks an embedder closed for good; shutdown must clear self._embed_fn
    # so a later initialize() builds a fresh one rather than reusing the dead handle
    # (which would raise "embedder is closed" on every call).
    provider, _ = _wired()
    assert provider._embed_fn is not None
    provider.shutdown()
    assert provider._embed_fn is None


def test_http_embedder_reuses_one_client():
    class FakeResp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"data": [{"embedding": [0.1, 0.2]}]}

    class FakeClient:
        def __init__(self):
            self.posts = 0
            self.closed = False

        async def post(self, *a, **k):
            self.posts += 1
            return FakeResp()

        async def aclose(self):
            self.closed = True

    embedder = build_http_embed_fn(EmbeddingConfig(api_key="sk-x"))
    fake = FakeClient()
    embedder._client = fake  # pre-seed so no real network / client construction

    async def _drive():
        a = await embedder("hello")
        b = await embedder("world")
        return a, b

    a, b = asyncio.new_event_loop().run_until_complete(_drive())
    assert a == [0.1, 0.2] and b == [0.1, 0.2]
    assert fake.posts == 2          # two embeds...
    assert embedder._client is fake  # ...reusing the SAME client

    asyncio.new_event_loop().run_until_complete(embedder.aclose())
    assert fake.closed is True
    assert embedder._client is None


def test_http_embedder_does_not_rebuild_after_close():
    # After aclose(), a late embed queued during shutdown must not resurrect a
    # client on a dying loop — it fails fast instead.
    embedder = build_http_embed_fn(EmbeddingConfig(api_key="sk-x"))
    asyncio.new_event_loop().run_until_complete(embedder.aclose())

    try:
        embedder._get_client()
        assert False, "expected RuntimeError after close"
    except RuntimeError:
        pass

    try:
        asyncio.new_event_loop().run_until_complete(embedder("hello"))
        assert False, "expected RuntimeError after close"
    except RuntimeError:
        pass

    assert embedder._client is None  # never rebuilt


# --------------------------------------------------------------------------- #
# LoopRuntime: timeout cancellation + graceful stop
# --------------------------------------------------------------------------- #

def test_loop_runtime_run_cancels_on_timeout():
    runtime = LoopRuntime()
    runtime.start()
    try:
        cancelled = {"hit": False}

        async def slow():
            try:
                await asyncio.sleep(5)
            except asyncio.CancelledError:
                cancelled["hit"] = True
                raise

        try:
            runtime.run(slow(), timeout=0.2)
            assert False, "expected timeout"
        except concurrent.futures.TimeoutError:
            pass
        time.sleep(0.2)  # let the cancellation propagate on the loop
        assert cancelled["hit"] is True
    finally:
        runtime.stop()


def test_loop_runtime_stop_is_graceful_and_idempotent():
    runtime = LoopRuntime()
    runtime.start()
    assert runtime.run(asyncio.sleep(0, result=42)) == 42
    runtime.stop()
    runtime.stop()  # second call is a no-op, not an error


# --------------------------------------------------------------------------- #
# Analytics / telemetry: off by default, passed through to the SDK
# --------------------------------------------------------------------------- #

def test_config_telemetry_default_off():
    # Separate from discovery; opt-in, off unless explicitly enabled.
    assert _Config({"host": "x"}).telemetry is False
    assert _Config({"host": "x", "telemetry": True}).telemetry is True
    assert _Config({"host": "x", "telemetry": "true"}).telemetry is True
    assert _Config({"host": "x", "telemetry": "false"}).telemetry is False


def test_memory_store_built_with_analytics_off_by_default(monkeypatch):
    import betterdb_agent_memory

    captured: dict = {}

    class CapturingStore:
        def __init__(self, **kwargs):
            captured.clear()
            captured.update(kwargs)

        async def ensure_index(self):
            pass

        async def ensure_discovery_ready(self):
            pass

    monkeypatch.setattr(betterdb_agent_memory, "MemoryStore", CapturingStore)

    # No telemetry configured -> analytics must be OFF (SDK default is ON).
    provider = BetterDBMemoryProvider(
        config={"host": "127.0.0.1"}, runtime=FakeRuntime(), embed_fn=lambda t: None,
    )
    provider.initialize("s1", agent_id="hermes")
    assert captured["analytics"] is False

    # Opt in -> analytics ON, passed through.
    provider = BetterDBMemoryProvider(
        config={"host": "127.0.0.1", "telemetry": True}, runtime=FakeRuntime(),
        embed_fn=lambda t: None,
    )
    provider.initialize("s1", agent_id="hermes")
    assert captured["analytics"] is True


# --------------------------------------------------------------------------- #
# user_id folded into the effective namespace (per-user scope)
# --------------------------------------------------------------------------- #

def test_effective_namespace_combinations():
    provider, _ = _wired(namespace="team")
    provider._user_id = ""
    assert provider._effective_namespace() == "team"
    provider._user_id = "alice"
    assert provider._effective_namespace() == "team:alice"
    provider._config.namespace = ""
    assert provider._effective_namespace() == "alice"
    provider._user_id = ""
    assert provider._effective_namespace() is None


def test_user_id_scopes_recall_and_remember():
    store = FakeStore(hits=[FakeHit(FakeItem("1", "x"))])
    provider = BetterDBMemoryProvider(
        config={"host": "127.0.0.1", "namespace": "team"},
        store=store, runtime=FakeRuntime(), embed_fn=lambda t: None,
    )
    # Gateway passes the end user's id into initialize kwargs.
    provider.initialize("s1", agent_id="hermes", user_id="alice")
    assert provider._effective_namespace() == "team:alice"

    provider.queue_prefetch("q", session_id="s1")
    assert store.recalled[0]["namespace"] == "team:alice"

    provider.sync_turn("hi", "ok", session_id="s1")
    assert store.remembered[0]["namespace"] == "team:alice"


def test_user_id_alt_fallback():
    store = FakeStore()
    provider = BetterDBMemoryProvider(
        config={"host": "127.0.0.1"}, store=store, runtime=FakeRuntime(),
        embed_fn=lambda t: None,
    )
    provider.initialize("s1", agent_id="hermes", user_id_alt="bob")
    assert provider._effective_namespace() == "bob"


# --------------------------------------------------------------------------- #
# Shutdown waits for a pending write before the drain cancels it
# --------------------------------------------------------------------------- #

def test_shutdown_waits_for_pending_write():
    class SlowStore(FakeStore):
        async def remember(self, content, **kw):
            await asyncio.sleep(0.3)  # still in flight when shutdown() is called
            self.remembered.append({"content": content})
            return "mem-1"

    store = SlowStore()
    provider = BetterDBMemoryProvider(
        config={"host": "127.0.0.1"}, store=store, runtime=LoopRuntime(),
        embed_fn=lambda t: None,
    )
    provider.initialize("s1", agent_id="hermes")
    provider.sync_turn("remember me", "ok", session_id="s1")  # fire-and-forget

    provider.shutdown()  # must wait for the write before cancelling it

    assert store.remembered, "final write was lost on shutdown"
    assert store.remembered[0]["content"].startswith("User: remember me")


# --------------------------------------------------------------------------- #
# forget refuses an id outside the caller's scope
# --------------------------------------------------------------------------- #

def test_tool_forget_refuses_foreign_agent():
    store = FakeStore(get_item=FakeItem("x", "secret", agent_id="other-agent"))
    provider, store = _wired(store)
    out = json.loads(provider.handle_tool_call("betterdb_forget", {"id": "x"}))
    assert "error" in out and "scope" in out["error"].lower()
    assert store.forgotten == []  # never deleted


def test_tool_forget_refuses_foreign_namespace():
    store = FakeStore(get_item=FakeItem("x", "secret", agent_id="hermes", namespace="someone-else"))
    provider, store = _wired(store)  # provider scope has no namespace
    out = json.loads(provider.handle_tool_call("betterdb_forget", {"id": "x"}))
    assert "error" in out and "scope" in out["error"].lower()
    assert store.forgotten == []


def test_tool_forget_missing_id_reports_not_found():
    store = FakeStore(get_item=None)
    provider, store = _wired(store)
    out = json.loads(provider.handle_tool_call("betterdb_forget", {"id": "gone"}))
    assert out["removed"] is False and out["status"] == "not found"
    assert store.forgotten == []


# --------------------------------------------------------------------------- #
# Out-of-order recall: a late older result must not overwrite a newer one
# --------------------------------------------------------------------------- #

def test_out_of_order_recall_drops_stale_result():
    class SeqStore(FakeStore):
        def __init__(self, contents):
            super().__init__()
            self._contents = contents
            self._i = 0

        async def recall(self, query, **kw):
            c = self._contents[self._i]
            self._i += 1
            return [FakeHit(FakeItem(str(self._i), c))]

    class DeferredRuntime(FakeRuntime):
        """Computes each coroutine's result eagerly but leaves the Future unset, so
        the test can resolve futures (and fire their done-callbacks) in any order."""

        def __init__(self):
            super().__init__()
            self.pending: list = []

        def submit(self, coro):
            fut: Future = Future()
            self.pending.append((fut, self._drive(coro)))
            return fut

    rt = DeferredRuntime()
    store = SeqStore(["first", "second"])
    provider = BetterDBMemoryProvider(
        config={"host": "127.0.0.1"}, store=store, runtime=rt, embed_fn=lambda t: None,
    )
    provider.initialize("s1", agent_id="hermes")
    rt.pending.clear()  # discard the ensure_index future queued by initialize

    provider.queue_prefetch("q1", session_id="s1")  # seq 1 -> "first"
    provider.queue_prefetch("q2", session_id="s1")  # seq 2 -> "second"
    (fut1, r1), (fut2, r2) = rt.pending[0], rt.pending[1]

    fut2.set_result(r2)  # newer recall finishes first and caches "second"
    fut1.set_result(r1)  # older recall finishes late -> must be dropped

    block = provider.prefetch("q", session_id="s1")
    assert "second" in block and "first" not in block


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #

def test_register_hook():
    captured = {}

    class Ctx:
        def register_memory_provider(self, provider):
            captured["provider"] = provider

    register(Ctx())
    assert captured["provider"].name == "betterdb"
