from __future__ import annotations

import math
import re
from typing import Any

from betterdb_valkey_search_kit import decode_float32

from .types import Store


def _decode_float32(value: Any) -> list[float]:
    if not isinstance(value, (bytes, bytearray)):
        return []
    return decode_float32(bytes(value))


def _cosine_distance(a: list[float], b: list[float]) -> float:
    dot = 0.0
    na = 0.0
    nb = 0.0
    length = min(len(a), len(b))
    for i in range(length):
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    denom = (math.sqrt(na) * math.sqrt(nb)) or 1.0
    return 1 - dot / denom


def _unescape_tag(value: str) -> str:
    return re.sub(r"\\(.)", r"\1", value)


_KNN_RE = re.compile(r"\[KNN (\d+) @(\S+) \$vec AS (\S+)\]")
_TAG_RE = re.compile(r"@(\w+):\{([^}]*)\}")
_NUM_RE = re.compile(r"@(\w+):\[(\S+) (\S+)\]")


def _parse_query(query_string: str) -> dict[str, Any]:
    knn = _KNN_RE.search(query_string)
    if knn is None:
        raise ValueError(f"Mock FT.SEARCH could not parse KNN clause: {query_string}")
    k = int(knn.group(1))
    score_field = knn.group(3)

    filter_expr = query_string[: query_string.index("=>")]
    tag_filters: list[tuple[str, str]] = []
    numeric_filters: list[tuple[str, float]] = []

    if filter_expr.strip() != "*":
        for m in _TAG_RE.finditer(filter_expr):
            tag_filters.append((m.group(1), _unescape_tag(m.group(2))))
        for m in _NUM_RE.finditer(filter_expr):
            numeric_filters.append((m.group(1), float(m.group(2))))

    return {
        "k": k,
        "score_field": score_field,
        "tag_filters": tag_filters,
        "numeric_filters": numeric_filters,
    }


def _s(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf8", "replace")
    return str(value)


class MockRetrieverClient:
    """In-memory store implementing the subset of the valkey-search command
    surface the Retriever uses. FT.SEARCH parses the query string the SDK builds,
    decodes the Float32 PARAMS vector, computes cosine distance to every stored
    vector, applies tag/numeric filters and returns the top-k in the exact reply
    shape parse_ft_search_response expects. Behaves like FLAT-exact (≈ HNSW on
    small data), and is fully synchronous so Tier 0 is deterministic.
    """

    def __init__(self) -> None:
        self._indexes: dict[str, dict[str, Any]] = {}
        self._hashes: dict[str, dict[str, Any]] = {}

    async def execute_command(self, *args: Any) -> Any:
        command = _s(args[0]).upper()
        rest = list(args[1:])
        if command == "HSET":
            return self._hset(rest)
        if command == "DEL":
            return self._del(rest)
        if command == "HDEL":
            return self._hdel(rest)
        if command == "FT.CREATE":
            return self._ft_create(rest)
        if command == "FT.INFO":
            return self._ft_info(rest)
        if command == "FT.DROPINDEX":
            return self._ft_drop_index(rest)
        if command == "FT._LIST":
            return list(self._indexes.keys())
        if command == "FT.SEARCH":
            return self._ft_search(rest)
        raise ValueError(f"MockRetrieverClient: unsupported command {command}")

    def _hset(self, args: list[Any]) -> int:
        key = _s(args[0])
        hashmap = self._hashes.setdefault(key, {})
        i = 1
        while i + 1 < len(args):
            field = _s(args[i])
            value = args[i + 1]
            hashmap[field] = value if isinstance(value, (bytes, bytearray)) else _s(value)
            i += 2
        return 1

    def _del(self, args: list[Any]) -> int:
        removed = 0
        for arg in args:
            if self._hashes.pop(_s(arg), None) is not None:
                removed += 1
        return removed

    def _hdel(self, args: list[Any]) -> int:
        key = _s(args[0])
        hashmap = self._hashes.get(key)
        if hashmap is None:
            return 0
        removed = 0
        for arg in args[1:]:
            if hashmap.pop(_s(arg), None) is not None:
                removed += 1
        return removed

    def _ft_create(self, args: list[Any]) -> str:
        tokens = [_s(a) for a in args]
        name = tokens[0]
        prefix_idx = tokens.index("PREFIX")
        prefix = tokens[prefix_idx + 2]
        schema_idx = tokens.index("SCHEMA")
        field_types: dict[str, str] = {}
        vector_field = "embedding"
        dims = 0

        i = schema_idx + 1
        while i < len(tokens):
            field_name = tokens[i]
            field_type = tokens[i + 1]
            i += 2
            if field_type == "TAG":
                field_types[field_name] = "tag"
                if i < len(tokens) and tokens[i] == "SEPARATOR":
                    i += 2
            elif field_type == "NUMERIC":
                field_types[field_name] = "numeric"
                if i < len(tokens) and tokens[i] == "SORTABLE":
                    i += 1
            elif field_type == "TEXT":
                field_types[field_name] = "text"
            elif field_type == "VECTOR":
                field_types[field_name] = "vector"
                vector_field = field_name
                count = int(tokens[i + 1])
                pair_start = i + 2
                for j in range(pair_start, pair_start + count, 2):
                    if tokens[j] == "DIM":
                        dims = int(tokens[j + 1])
                i = pair_start + count
            else:
                # Unknown token; skip defensively.
                i += 1

        self._indexes[name] = {
            "name": name,
            "prefix": prefix,
            "vector_field": vector_field,
            "dims": dims,
            "field_types": field_types,
        }
        return "OK"

    def _require_index(self, name: str) -> dict[str, Any]:
        cfg = self._indexes.get(name)
        if cfg is None:
            raise ValueError(f"Unknown index name: {name}")
        return cfg

    def _docs_for_index(self, cfg: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        prefix = cfg["prefix"]
        return [(k, v) for k, v in self._hashes.items() if k.startswith(prefix)]

    def _ft_info(self, args: list[Any]) -> list[Any]:
        name = _s(args[0])
        cfg = self._require_index(name)
        num_docs = len(self._docs_for_index(cfg))
        return [
            "index_name",
            name,
            "num_docs",
            str(num_docs),
            "indexing",
            "0",
            "percent_indexed",
            "1",
            "attributes",
            [["identifier", cfg["vector_field"], "type", "VECTOR", "dim", str(cfg["dims"])]],
        ]

    def _ft_drop_index(self, args: list[Any]) -> str:
        name = _s(args[0])
        self._require_index(name)
        del self._indexes[name]
        return "OK"

    def _ft_search(self, args: list[Any]) -> list[Any]:
        name = _s(args[0])
        cfg = self._require_index(name)
        query_string = _s(args[1])
        parsed = _parse_query(query_string)

        vec_idx = next(
            (
                i
                for i, a in enumerate(args)
                if not isinstance(a, (bytes, bytearray)) and _s(a) == "vec"
            ),
            -1,
        )
        query_vec = _decode_float32(args[vec_idx + 1])

        scored: list[tuple[str, dict[str, Any], float]] = []
        for key, hashmap in self._docs_for_index(cfg):
            passed = True
            for field, value in parsed["tag_filters"]:
                if _s(hashmap.get(field, "")) != value:
                    passed = False
                    break
            if passed:
                for field, value in parsed["numeric_filters"]:
                    try:
                        if float(_s(hashmap.get(field))) != value:
                            passed = False
                            break
                    except (TypeError, ValueError):
                        passed = False
                        break
            if not passed:
                continue
            doc_vec = _decode_float32(hashmap.get(cfg["vector_field"]))
            scored.append((key, hashmap, _cosine_distance(query_vec, doc_vec)))

        scored.sort(key=lambda row: row[2])
        top = scored[: parsed["k"]]

        reply: list[Any] = [str(len(top))]
        for key, hashmap, distance in top:
            field_array: list[str] = []
            for field, value in hashmap.items():
                if field == cfg["vector_field"]:
                    continue
                field_array.extend([field, _s(value)])
            field_array.extend([parsed["score_field"], str(distance)])
            reply.append(key)
            reply.append(field_array)
        return reply


class _MockStore:
    def __init__(self) -> None:
        self.name = "mock-in-memory"
        self.is_real = False
        self.client = MockRetrieverClient()

    async def close(self) -> None:
        return None


def create_mock_store() -> Store:
    return _MockStore()


class _RealStore:
    def __init__(self, name: str, client: Any) -> None:
        self.name = name
        self.is_real = True
        self.client = client
        self._raw = client

    async def close(self) -> None:
        try:
            await self._raw.aclose()
        except Exception:
            pass


_PASSWORD_RE = re.compile(r":[^:@/]*@")


async def create_real_store(url: str) -> Store | None:
    """Real valkey-search store via valkey-py asyncio. Returns ``None`` if the
    server is unreachable or the search module (FT._LIST) is absent, so callers
    can fall back to the mock store gracefully.
    """
    try:
        from valkey.asyncio import from_url
    except ImportError:
        return None

    client = from_url(url)
    try:
        await client.ping()
        await client.execute_command("FT._LIST")
    except Exception:
        try:
            await client.aclose()
        except Exception:
            pass
        return None
    masked = _PASSWORD_RE.sub(":***@", url)
    return _RealStore(name=f"valkey-search@{masked}", client=client)
