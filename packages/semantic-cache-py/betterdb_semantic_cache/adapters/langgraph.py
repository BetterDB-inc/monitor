"""LangGraph BaseStore adapter for betterdb-semantic-cache.

BetterDBSemanticStore implements a subset of the LangGraph BaseStore interface,
enabling similarity-based memory retrieval from a SemanticCache instance.

Usage::

    from betterdb_semantic_cache.adapters.langgraph import BetterDBSemanticStore
    store = BetterDBSemanticStore(cache=semantic_cache)
    await store.aput(["user", "alice"], "mem1", {"content": "Alice likes coffee"})
    results = await store.asearch(["user", "alice"], query="What does Alice drink?")
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..semantic_cache import SemanticCache


@dataclass
class Item:
    """A stored item in the semantic memory store."""
    namespace: list[str]
    key: str
    value: dict[str, Any]
    created_at: str
    updated_at: str


def _namespace_key(namespace: list[str]) -> str:
    return ":".join(namespace)


def _namespace_to_category(namespace: list[str]) -> str:
    return _namespace_key(namespace).replace(".", "_").replace("/", "_")


class BetterDBSemanticStore:
    """LangGraph-compatible semantic memory store backed by SemanticCache.

    Args:
        cache: A pre-configured SemanticCache instance.
        embed_field: Field to embed from stored values. Default: 'content'.
    """

    def __init__(self, cache: "SemanticCache", *, embed_field: str = "content") -> None:
        self._cache = cache
        self._embed_field = embed_field

    async def aput(
        self, namespace: list[str], key: str, value: dict[str, Any]
    ) -> None:
        """Store a value at namespace/key."""
        import json
        import time

        embed_text = (
            value[self._embed_field]
            if isinstance(value.get(self._embed_field), str)
            else json.dumps(value)
        )
        category = _namespace_to_category(namespace)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        item = Item(namespace=namespace, key=key, value=value,
                    created_at=now, updated_at=now)

        from ..types import CacheStoreOptions
        await self._cache.store(
            embed_text,
            json.dumps({"namespace": namespace, "key": key, "value": value,
                        "created_at": now, "updated_at": now}),
            CacheStoreOptions(
                category=category,
                metadata={"key": key, "namespace": _namespace_key(namespace)},
            ),
        )

    async def aget(self, namespace: list[str], key: str) -> Item | None:
        """Retrieve a value by exact namespace and key."""
        import json

        from ..utils import parse_ft_search_response
        category = _namespace_to_category(namespace)
        try:
            raw = await self._cache._client.execute_command(
                "FT.SEARCH",
                self._cache._index_name,
                f"@category:{{{category}}}",
                "LIMIT", "0", "100",
                "DIALECT", "2",
            )
        except Exception:
            return None

        parsed = parse_ft_search_response(raw)
        for entry in parsed:
            response_str = entry["fields"].get("response")
            if not response_str:
                continue
            try:
                data = json.loads(response_str)
                if data.get("key") == key:
                    return Item(
                        namespace=data.get("namespace", namespace),
                        key=data.get("key", key),
                        value=data.get("value", {}),
                        created_at=data.get("created_at", ""),
                        updated_at=data.get("updated_at", ""),
                    )
            except (json.JSONDecodeError, TypeError):
                pass
        return None

    async def asearch(
        self,
        namespace: list[str],
        *,
        query: str | None = None,
        limit: int = 10,
        threshold: float | None = None,
    ) -> list[Item]:
        """Search the namespace using similarity or scan."""
        import json

        category = _namespace_to_category(namespace)

        if query:
            from ..types import CacheCheckOptions
            results = await self._cache.check_batch(
                [query],
                CacheCheckOptions(category=category, k=limit, threshold=threshold),
            )
            items = []
            for result in results:
                if result.hit and result.response:
                    try:
                        data = json.loads(result.response)
                        items.append(Item(
                            namespace=data.get("namespace", namespace),
                            key=data.get("key", ""),
                            value=data.get("value", {}),
                            created_at=data.get("created_at", ""),
                            updated_at=data.get("updated_at", ""),
                        ))
                    except (json.JSONDecodeError, TypeError):
                        pass
            return items

        # No query — return all entries in namespace
        from ..utils import parse_ft_search_response
        try:
            raw = await self._cache._client.execute_command(
                "FT.SEARCH",
                self._cache._index_name,
                f"@category:{{{category}}}",
                "LIMIT", "0", str(limit),
                "DIALECT", "2",
            )
        except Exception:
            return []

        items = []
        for entry in parse_ft_search_response(raw):
            response_str = entry["fields"].get("response")
            if response_str:
                try:
                    data = json.loads(response_str)
                    items.append(Item(
                        namespace=data.get("namespace", namespace),
                        key=data.get("key", ""),
                        value=data.get("value", {}),
                        created_at=data.get("created_at", ""),
                        updated_at=data.get("updated_at", ""),
                    ))
                except (json.JSONDecodeError, TypeError):
                    pass
        return items

    async def adelete(self, namespace: list[str], key: str) -> None:
        """Delete all entries at namespace/key."""
        await self._cache.invalidate_by_category(_namespace_to_category(namespace))

    async def abatch(
        self,
        writes: list[dict[str, Any]],
    ) -> None:
        """Batch put/delete multiple items."""
        import asyncio

        async def _apply(write: dict[str, Any]) -> None:
            ns = write["namespace"]
            k = write["key"]
            v = write.get("value")
            if v is None:
                await self.adelete(ns, k)
            else:
                await self.aput(ns, k, v)

        await asyncio.gather(*[_apply(w) for w in writes])
