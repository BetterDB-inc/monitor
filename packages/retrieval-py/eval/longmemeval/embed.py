from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

from .openai_http import post_json
from .types import Embedder

MOCK_DIM = 256
OPENAI_MODEL = "text-embedding-3-small"
OPENAI_DIM = 1536
_OPENAI_URL = "https://api.openai.com/v1/embeddings"

_TOKEN_RE = re.compile(r"[^a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.split(text.lower()) if len(t) > 0]


def _l2normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class _MockEmbedder:
    """Deterministic hashed bag-of-words embedding. Each token is hashed into a
    few fixed dimensions; lexical overlap raises cosine similarity. Enough to
    prove ranking, not a real semantic score. No network, no keys.
    """

    def __init__(self, dim: int = MOCK_DIM) -> None:
        self.name = f"mock-hashed-bow(dim={dim})"
        self.dims = dim
        self._dim = dim

    async def embed(self, text: str) -> list[float]:
        vec = [0.0] * self._dim
        for token in _tokenize(text):
            h = hashlib.sha256(token.encode("utf8")).digest()
            # Spread each token across 4 slots with signed weights.
            for s in range(4):
                idx = int.from_bytes(h[s * 4 : s * 4 + 4], "little") % self._dim
                sign = 1 if (h[s * 4 + 3] & 1) == 0 else -1
                vec[idx] += sign
        return _l2normalize(vec)

    async def flush(self) -> None:
        return None


def create_mock_embedder(dim: int = MOCK_DIM) -> Embedder:
    return _MockEmbedder(dim)


class _EmbedCache:
    def __init__(self, path: str) -> None:
        self._path = path
        self._dirty = False
        self._map: dict[str, list[float]] = {}
        try:
            loaded = json.loads(Path(path).read_text(encoding="utf8"))
        except (OSError, ValueError):
            # No cache yet; start empty.
            loaded = {}
        # A valid-but-non-object cache (null, a list, ...) must not replace the
        # dict, or the first get()/set() would raise AttributeError.
        if isinstance(loaded, dict):
            self._map = loaded

    def get(self, key: str) -> list[float] | None:
        return self._map.get(key)

    def set(self, key: str, vec: list[float]) -> None:
        self._map[key] = vec
        self._dirty = True

    def flush(self) -> None:
        if not self._dirty:
            return
        try:
            path = Path(self._path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(self._map), encoding="utf8")
            self._dirty = False
        except OSError as err:
            # The on-disk cache is only a cost optimization; never let a flush
            # failure discard an otherwise-completed eval — warn and continue.
            print(f"embedding cache flush skipped: {err}")


class _OpenAIEmbedder:
    """Real OpenAI text-embedding-3-small (1536 dims) with an on-disk,
    content-addressed cache so re-runs are cheap and indexing isn't re-billed.
    """

    def __init__(self, api_key: str, cache_path: str) -> None:
        self.name = f"openai:{OPENAI_MODEL}"
        self.dims = OPENAI_DIM
        self._api_key = api_key
        self._cache = _EmbedCache(cache_path)

    async def embed(self, text: str) -> list[float]:
        key = hashlib.sha256(f"{OPENAI_MODEL}\n{text}".encode("utf8")).hexdigest()
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        json_resp = await post_json(
            _OPENAI_URL, self._api_key, {"model": OPENAI_MODEL, "input": text}, "embeddings"
        )
        vec = json_resp["data"][0]["embedding"]
        self._cache.set(key, vec)
        return vec

    async def flush(self) -> None:
        self._cache.flush()


def create_openai_embedder(api_key: str, cache_path: str) -> Embedder:
    return _OpenAIEmbedder(api_key, cache_path)
