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

import json
import math
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..utils import escape_tag

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
    # Replace path separators (. and /) with underscore, leaving : intact as
    # the namespace-segment separator. Matches the TypeScript implementation.
    return re.sub(r'[./]', '_', _namespace_key(namespace))


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
        """Store a value at namespace/key (upsert — deletes existing entry first)."""
        import time

        await self._cache.initialize()

        # Upsert: remove any existing entry for this key before writing a new one
        # so repeated aput() calls don't accumulate stale duplicates.
        await self.adelete(namespace, key)

        embed_text = (
            value[self._embed_field]
            if isinstance(value.get(self._embed_field), str)
            else json.dumps(value)
        )
        category = _namespace_to_category(namespace)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

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
        await self._cache.initialize()
        from ..utils import parse_ft_search_response
        category = _namespace_to_category(namespace)
        try:
            raw = await self._cache._client.execute_command(
                "FT.SEARCH",
                self._cache._index_name,
                f"@category:{{{escape_tag(category)}}}",
                "LIMIT", "0", "100",
                "DIALECT", "2",
            )
        except Exception:
            return None

        for entry in parse_ft_search_response(raw):
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
        """Search the namespace using similarity or scan.

        When query is provided, performs a KNN vector search returning up to
        limit results. When query is absent, returns all entries in the namespace.
        """
        await self._cache.initialize()
        from ..utils import encode_float32, parse_ft_search_response
        category = _namespace_to_category(namespace)

        if query:
            # Direct KNN FT.SEARCH so we can retrieve top-k, not just 1 result.
            eff_threshold = (
                threshold if threshold is not None else self._cache._default_threshold
            )
            vector, _ = await self._cache._embed(query)
            filter_expr = f"(@category:{{{escape_tag(category)}}})"
            knn_query = f"{filter_expr}=>[KNN {limit} @embedding $vec AS __score]"
            try:
                raw = await self._cache._client.execute_command(
                    "FT.SEARCH", self._cache._index_name, knn_query,
                    "PARAMS", "2", "vec", encode_float32(vector),
                    "LIMIT", "0", str(limit),
                    "DIALECT", "2",
                )
            except Exception:
                return []

            items = []
            for entry in parse_ft_search_response(raw):
                score_str = entry["fields"].get("__score")
                try:
                    score = float(score_str) if score_str is not None else float("nan")
                except (ValueError, TypeError):
                    score = float("nan")
                if math.isnan(score) or score > eff_threshold:
                    continue
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

        # No query — return all entries in namespace
        try:
            raw = await self._cache._client.execute_command(
                "FT.SEARCH",
                self._cache._index_name,
                f"@category:{{{escape_tag(category)}}}",
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

    _DELETE_SCAN_BATCH = 100

    async def adelete(self, namespace: list[str], key: str) -> None:
        """Delete the specific entry at namespace/key.

        Scans the namespace category page by page and deletes only Valkey keys
        whose stored JSON response matches the given key, leaving other entries
        in the same namespace intact. Loops until no more matching entries are
        found so namespaces larger than one page are handled correctly.
        """
        await self._cache.initialize()
        from ..utils import parse_ft_search_response
        category = _namespace_to_category(namespace)
        cat_filter = f"@category:{{{escape_tag(category)}}}"

        while True:
            try:
                raw = await self._cache._client.execute_command(
                    "FT.SEARCH",
                    self._cache._index_name,
                    cat_filter,
                    "LIMIT", "0", str(self._DELETE_SCAN_BATCH),
                    "DIALECT", "2",
                )
            except Exception:
                return

            entries = parse_ft_search_response(raw)
            if not entries:
                break

            deleted_any = False
            for entry in entries:
                response_str = entry["fields"].get("response")
                if not response_str:
                    continue
                try:
                    data = json.loads(response_str)
                    if data.get("key") == key:
                        try:
                            await self._cache._client.delete(entry["key"])
                            deleted_any = True
                        except Exception:
                            pass
                except (json.JSONDecodeError, TypeError):
                    pass

            if not deleted_any:
                # This page contained no matching entries; if it was a full page
                # there may be more entries beyond, but none will match our key
                # (since all pages are sorted the same way and we start from 0).
                # A full page with zero matches means the key does not exist.
                break

    async def abatch(
        self,
        writes: list[dict[str, Any]],
    ) -> None:
        """Batch put/delete multiple items.

        Writes are executed sequentially to avoid race conditions when the same
        (namespace, key) appears more than once in a single batch: concurrent
        execution would let two adelete+store pairs interleave, leaving duplicates.
        """
        for write in writes:
            try:
                ns = write["namespace"]
                k = write["key"]
            except KeyError as exc:
                raise ValueError(
                    f"Each write entry must have 'namespace' and 'key' fields; missing: {exc}"
                ) from exc
            v = write.get("value")
            if v is None:
                await self.adelete(ns, k)
            else:
                await self.aput(ns, k, v)
