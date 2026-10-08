"""Unit tests: provider construction, availability, and the recall/remember mapping.

The SDK client is mocked end-to-end (``FakeStore`` + ``FakeRuntime``), so nothing
here needs a live Valkey or an embeddings endpoint.
"""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import Future
from dataclasses import dataclass
from typing import List

from betterdb_hermes_memory import RECALL_K, BetterDBMemoryProvider, register
from betterdb_hermes_memory.embeddings import EmbeddingConfig


# --------------------------------------------------------------------------- #
# Test doubles
# --------------------------------------------------------------------------- #

@dataclass
class FakeItem:
    id: str
    content: str


@dataclass
class FakeHit:
    item: FakeItem
    score: float = 0.9
    similarity: float = 0.1


class FakeStore:
    def __init__(self, hits: List[FakeHit] | None = None):
        self._hits = hits or []
        self.remembered: list = []
        self.recalled: list = []
        self.forgotten: list = []
        self.index_ready = False
        self.closed = False

    async def ensure_index(self) -> None:
        self.index_ready = True

    async def recall(self, query, *, k=None, agent_id=None, thread_id=None, namespace=None, **kw):
        self.recalled.append({"query": query, "k": k, "agent_id": agent_id, "namespace": namespace})
        return self._hits

    async def remember(self, content, *, importance=None, tags=None, source=None,
                       agent_id=None, thread_id=None, namespace=None, **kw):
        self.remembered.append({
            "content": content, "importance": importance, "tags": tags,
            "source": source, "agent_id": agent_id, "thread_id": thread_id,
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

    def stop(self, *, timeout=5.0) -> None:
        self.stopped = True


def _wired(store: FakeStore | None = None, **cfg):
    store = store if store is not None else FakeStore()
    provider = BetterDBMemoryProvider(
        config=cfg or {},
        store=store,
        runtime=FakeRuntime(),
        embed_fn=lambda text: None,  # presence satisfies is_available; never called here
    )
    return provider, store


# --------------------------------------------------------------------------- #
# Availability
# --------------------------------------------------------------------------- #

def test_embedding_config_readiness():
    assert EmbeddingConfig().is_configured() is False  # default hosted endpoint, no key
    assert EmbeddingConfig(api_key="sk-x").is_configured() is True
    assert EmbeddingConfig(base_url="http://localhost:11434/v1").is_configured() is True


def test_is_available_true_with_embed_fn():
    provider, _ = _wired()
    # Default localhost connection + injected embed_fn + SDK importable -> available.
    assert provider.is_available() is True


def test_is_available_false_without_embeddings():
    provider = BetterDBMemoryProvider(config={})  # no embed_fn, default (unconfigured) embeddings
    assert provider.is_available() is False
    assert "embeddings" in provider.unavailable_reason().lower()


def test_name():
    provider, _ = _wired()
    assert provider.name == "betterdb"


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
# Registration
# --------------------------------------------------------------------------- #

def test_register_hook():
    captured = {}

    class Ctx:
        def register_memory_provider(self, provider):
            captured["provider"] = provider

    register(Ctx())
    assert captured["provider"].name == "betterdb"
