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
  (``api_key``, ``base_url``, ``model``). This covers OpenAI, Azure OpenAI,
  Ollama, LM Studio, vLLM and the like without a heavyweight local model.

The HTTP embedder imports ``httpx`` lazily so merely importing this module (or the
provider) never pulls a network dependency — matters for ``is_available()`` and
for running the unit tests without optional deps installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, List

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


def build_http_embed_fn(config: EmbeddingConfig) -> EmbedFn:
    """Return an async ``embed_fn`` backed by an OpenAI-compatible endpoint."""

    base = config.base_url.rstrip("/")
    url = f"{base}/embeddings"

    async def embed(text: str) -> List[float]:
        import httpx  # lazy: keep module import network-free

        headers = {"Content-Type": "application/json"}
        if config.api_key:
            headers["Authorization"] = f"Bearer {config.api_key}"
        payload = {"model": config.model, "input": text}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        # OpenAI shape: {"data": [{"embedding": [...]}]}
        return [float(x) for x in data["data"][0]["embedding"]]

    return embed
