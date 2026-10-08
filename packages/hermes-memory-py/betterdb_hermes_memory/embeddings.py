"""Embedding function resolution for the memory tier.

``betterdb-agent-memory`` does NOT ship an embedding model — ``MemoryStore``
requires an ``embed_fn: Callable[[str], Awaitable[list[float]]]`` that the caller
supplies (``remember`` / ``recall`` / ``ensure_index`` all raise without one).
Hermes does not hand providers an embedding seam either, so this module resolves
one from configuration.

Two ways to get an ``embed_fn``:

* Inject one directly into the provider (used by tests and by embedders Hermes
  may wire in later).
* Configure an OpenAI-compatible ``/v1/embeddings`` HTTP endpoint via env / config
  (``api_key``, ``base_url``, ``model``). This covers OpenAI, Ollama, LM Studio,
  vLLM and the like without a heavyweight local model.

The HTTP embedder imports ``httpx`` lazily so merely importing this module (or the
provider) never pulls a network dependency — matters for ``is_available()`` and
for running the unit tests without optional deps installed. It also keeps a SINGLE
``httpx.AsyncClient`` alive for the life of the provider (built on the runtime
loop on first use, closed via :meth:`_HttpEmbedder.aclose`) so each embed call
reuses the connection pool / TLS session instead of standing up a fresh one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, List, Optional

EmbedFn = Callable[[str], Awaitable[List[float]]]

DEFAULT_EMBEDDINGS_BASE_URL = "https://api.openai.com/v1"
DEFAULT_EMBEDDINGS_MODEL = "text-embedding-3-small"


@dataclass
class EmbeddingConfig:
    """Connection details for an OpenAI-compatible embeddings endpoint."""

    model: str = DEFAULT_EMBEDDINGS_MODEL
    base_url: str = DEFAULT_EMBEDDINGS_BASE_URL
    api_key: str = ""

    def is_configured(self) -> bool:
        """Ready when there is a credential, or a self-hosted endpoint that needs
        none. The bare default (api.openai.com with no key) is NOT ready — a key is
        required there — so it reports unconfigured until one of the two is set."""
        if self.api_key:
            return True
        # A custom base_url (Ollama, vLLM, LM Studio, a gateway) typically needs no
        # key; only the hosted default is gated on a credential.
        return bool(self.base_url) and self.base_url.rstrip("/") != DEFAULT_EMBEDDINGS_BASE_URL.rstrip("/")


class _HttpEmbedder:
    """Callable ``embed_fn`` backed by an OpenAI-compatible endpoint.

    One ``httpx.AsyncClient`` is created lazily on the first call (which runs on
    the runtime's event loop) and reused for every subsequent embed, so recall and
    remember share a connection pool instead of paying a new TCP+TLS handshake per
    call. :meth:`aclose` tears it down at shutdown.
    """

    def __init__(self, config: EmbeddingConfig):
        self._config = config
        self._url = f"{config.base_url.rstrip('/')}/embeddings"
        self._client: Optional[Any] = None
        self._closed = False

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self._config.api_key:
            headers["Authorization"] = f"Bearer {self._config.api_key}"
        return headers

    def _get_client(self) -> Any:
        # Once closed, never resurrect the client: a late embed queued during
        # shutdown must not stand up a fresh client on a dying loop.
        if self._closed:
            raise RuntimeError("embedder is closed")
        # No await between the check and the assignment, and the runtime loop is
        # single-threaded, so concurrent embed coroutines can't race a second client.
        if self._client is None:
            import httpx  # lazy: keep module import network-free

            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    async def __call__(self, text: str) -> List[float]:
        if self._closed:
            raise RuntimeError("embedder is closed")
        client = self._get_client()
        payload = {"model": self._config.model, "input": text}
        resp = await client.post(self._url, json=payload, headers=self._headers())
        resp.raise_for_status()
        data = resp.json()
        # OpenAI shape: {"data": [{"embedding": [...]}]}
        return [float(x) for x in data["data"][0]["embedding"]]

    async def aclose(self) -> None:
        self._closed = True
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()


def build_http_embed_fn(config: EmbeddingConfig) -> _HttpEmbedder:
    """Return an async ``embed_fn`` (reusing one client) for an OpenAI-compatible endpoint."""
    return _HttpEmbedder(config)
