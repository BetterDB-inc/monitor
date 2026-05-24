"""
BetterDB SemanticCache adapter.

Deviation notes (vs. guide pseudo-code):
- Import is `from betterdb_semantic_cache import SemanticCache, SemanticCacheOptions`
  (not `betterdb_semantic_cache.SemanticCache` with a separate embed helper).
- Constructor takes a dataclass `SemanticCacheOptions(client, embed_fn, name, default_threshold)`.
- `EmbedFn` must be `async def (str) -> list[float]`.
- Clear is done via `cache.flush()` (drops and recreates the FT index) then `cache.initialize()`.
- The Python client is `valkey.asyncio` (not `iovalkey`, which is JS-only).
- `store()` requires no model/token args — they are optional in `CacheStoreOptions`.
- `check()` returns `CacheCheckResult` with `.hit`, `.response`, `.similarity`.

Mode feature matrix (verified against betterdb-semantic-cache 0.4.0):
  bare:  cosine-distance threshold only.
  local: k=3 candidates + keyword-overlap rerank. No external APIs.
  full:  k=3 candidates + keyword-overlap rerank + LLM-as-judge (OpenAI gpt-4o-mini).
         Requires OPENAI_API_KEY. Judge fires only on uncertain hits (within uncertainty_band).

Not available in any mode:
  - per-category thresholds: API exists but dataset has no categories.
  - auto-tuning: managed-service feature, not in the Python package.
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Literal

from cache_benchmark.adapters.base import CacheAdapter
from cache_benchmark.types import CheckResult


def _make_sbert_embed_fn(model_name: str):
    """Return an async embed function wrapping sentence-transformers."""
    import asyncio
    from sentence_transformers import SentenceTransformer  # type: ignore

    model = SentenceTransformer(model_name)

    async def embed(text: str) -> list[float]:
        loop = asyncio.get_running_loop()
        vec = await loop.run_in_executor(None, lambda: model.encode(text).tolist())
        return vec

    return embed


def _make_keyword_overlap_rerank_fn():
    """Keyword-overlap rerank: blend cosine similarity with word overlap against response text.

    Candidates: top-k hits from BetterDB, each a dict with keys:
      response (str)    — cached response text
      similarity (float) — cosine distance (lower = more similar)

    Score = 0.7 * (1 - similarity) + 0.3 * overlap(query_words, response_words)
    """
    async def rerank_fn(prompt: str, candidates: list[dict]) -> int:
        prompt_words = set(prompt.lower().split())
        best_idx, best_score = 0, -1.0
        for i, cand in enumerate(candidates):
            cand_words = set(str(cand.get("response", "")).lower().split())
            overlap = len(prompt_words & cand_words) / max(len(prompt_words), 1)
            sim = float(cand.get("similarity", 1.0))
            score = 0.7 * (1.0 - sim) + 0.3 * overlap
            if score > best_score:
                best_score, best_idx = score, i
        return best_idx

    return rerank_fn


def _make_openai_judge_fn(api_key: str, log_writer=None):
    """LLM-as-judge gate using gpt-4o-mini. Fires only on uncertain hits.

    Introspection note: betterdb_semantic_cache.SemanticCache has no external
    observer/callback for judge invocations. The `judge_fn` supplied by the caller
    IS the hook — we log from within it without modifying the package.
    ctx keys: prompt (query), response (cached response), similarity (cosine distance),
              threshold (current threshold), category (str | None).
    Note: the original cached prompt is not in ctx — only the cached response is available.
    prompt_a in the judge log is therefore the cached response text, not the stored query.
    """
    async def judge_fn(ctx: dict) -> bool:
        from openai import AsyncOpenAI  # type: ignore
        client = AsyncOpenAI(api_key=api_key)
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a semantic equivalence judge for a prompt cache. "
                        "Decide whether a cached response is an acceptable answer to a new query. "
                        "Answer only YES or NO."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"New query: {ctx.get('prompt', '')}\n\n"
                        f"Cached response: {str(ctx.get('response', ''))[:500]}\n\n"
                        "Is the cached response an acceptable answer to the new query?"
                    ),
                },
            ],
            max_tokens=5,
            temperature=0,
        )
        raw = resp.choices[0].message.content.strip()
        accepted = raw.upper().startswith("Y")

        if log_writer is not None:
            log_writer({
                # prompt_a = cached response text (original cached prompt unavailable in ctx)
                "prompt_a": str(ctx.get("response", "")),
                "prompt_b": ctx.get("prompt", ""),
                "similarity_score": ctx.get("similarity"),
                "judge_verdict": "match" if accepted else "nomatch",
                "judge_raw_response": raw,
            })

        return accepted

    return judge_fn


class BetterDBAdapter(CacheAdapter):
    name = "betterdb"

    def __init__(
        self,
        *,
        threshold: float,
        embedding_model: str,
        redis_url: str | None = None,
        mode: Literal["bare", "local", "full"] = "bare",
        **kwargs,
    ) -> None:
        super().__init__(threshold=threshold, embedding_model=embedding_model, redis_url=redis_url, mode=mode)
        self._cache_name = f"bench:betterdb:{uuid.uuid4().hex[:8]}"
        self._cache = None
        self._client = None

        self._debug_judge = kwargs.get("debug_judge", False)
        self._judge_log_writer = kwargs.get("judge_log_writer", None)

        self._openai_key = None
        if mode == "full":
            self._openai_key = os.environ.get("OPENAI_API_KEY")
            if not self._openai_key:
                raise EnvironmentError(
                    "[betterdb full mode] OPENAI_API_KEY is required for the LLM-as-judge gate. "
                    "Set it in your environment or use --mode local (rerank only, no API key needed) "
                    "or --mode bare."
                )

    def enabled_features(self) -> list[str]:
        if self.mode == "bare":
            return [
                "cosine-distance threshold",
                "NOT enabled: rerank (bare mode)",
                "NOT enabled: LLM-as-judge (bare mode)",
            ]
        if self.mode == "local":
            return [
                "cosine-distance threshold",
                "top-3 candidate retrieval (k=3)",
                "keyword-overlap rerank (cosine 70% + word-overlap 30%)",
                "NOT enabled: LLM-as-judge (local mode — no external APIs)",
                "NOT enabled: per-category thresholds (dataset has no categories)",
                "NOT enabled: auto-tuning (managed-service feature, not in Python package)",
            ]
        # full
        return [
            "cosine-distance threshold",
            "top-3 candidate retrieval (k=3)",
            "keyword-overlap rerank (cosine 70% + word-overlap 30%)",
            "LLM-as-judge gate on uncertain hits (gpt-4o-mini, uncertainty_band=0.05)",
            "NOT enabled: per-category thresholds (dataset has no categories)",
            "NOT enabled: auto-tuning (managed-service feature, not in Python package)",
        ]

    async def initialize(self) -> None:
        import valkey.asyncio as valkey  # type: ignore
        from betterdb_semantic_cache import SemanticCache  # type: ignore
        from betterdb_semantic_cache.types import (  # type: ignore
            SemanticCacheOptions, AnalyticsOptions, DiscoveryOptions, ConfigRefreshOptions,
        )

        url = self.redis_url or "redis://localhost:6379"
        self._client = valkey.Valkey.from_url(url, decode_responses=False)
        embed_fn = _make_sbert_embed_fn(self.embedding_model)

        opts = SemanticCacheOptions(
            client=self._client,
            embed_fn=embed_fn,
            name=self._cache_name,
            default_threshold=self.threshold,
            analytics=AnalyticsOptions(disabled=True),
            discovery=DiscoveryOptions(enabled=False),
            config_refresh=ConfigRefreshOptions(enabled=False),
        )
        self._cache = SemanticCache(opts)
        await self._cache.initialize()

    async def store(self, prompt: str, response: str) -> None:
        await self._cache.store(prompt, response)

    async def check(self, prompt: str) -> CheckResult:
        from betterdb_semantic_cache.types import CacheCheckOptions, RerankOptions, JudgeOptions  # type: ignore

        t0 = time.perf_counter()

        if self.mode == "bare":
            result = await self._cache.check(prompt)
        elif self.mode == "local":
            opts = CacheCheckOptions(
                k=3,
                rerank=RerankOptions(k=3, rerank_fn=_make_keyword_overlap_rerank_fn()),
            )
            result = await self._cache.check(prompt, options=opts)
        else:  # full
            log_writer = self._judge_log_writer if self._debug_judge else None
            opts = CacheCheckOptions(
                k=3,
                rerank=RerankOptions(k=3, rerank_fn=_make_keyword_overlap_rerank_fn()),
                judge=JudgeOptions(
                    judge_fn=_make_openai_judge_fn(self._openai_key, log_writer=log_writer),
                    on_error="accept",
                    timeout_ms=5000,
                ),
            )
            result = await self._cache.check(prompt, options=opts)

        latency_ms = (time.perf_counter() - t0) * 1000
        return CheckResult(
            hit=result.hit,
            cached_response=result.response if result.hit else None,
            similarity_score=result.similarity,
            latency_ms=latency_ms,
        )

    async def clear(self) -> None:
        if self._cache is not None:
            await self._cache.flush()
            await self._cache.initialize()

    async def close(self) -> None:
        if self._cache is not None:
            await self._cache.shutdown()
        if self._client is not None:
            await self._client.aclose()
