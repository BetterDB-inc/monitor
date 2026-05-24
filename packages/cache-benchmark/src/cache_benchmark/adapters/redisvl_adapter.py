"""
RedisVL SemanticCache adapter.

# To spin up Redis Stack for fair native-API comparison:
#   docker run -d --name redis-stack-bench -p 6383:6379 redis/redis-stack-server:latest
# Then run with redisvl_backend="redis-stack" and REDIS_STACK_URL=redis://localhost:6383.
# Rationale: redisvl 0.18.2 uses VectorRangeQuery internally which is incompatible with
# Valkey Search (see below). Redis Stack ships a supported search module version where the
# native check() path works, allowing a fair apples-to-apples latency comparison.

Deviation note: redisvl 0.18.2 SemanticCache.check() unconditionally uses
VectorRangeQuery internally, which is not supported by valkey-bundle's search
module (it emits 'VECTOR_RANGE ... not indexed as numeric field').

Workaround: we bypass cache.check() and query the underlying _index directly
using raw FT.SEARCH (KNN), then filter by distance in Python. All other
operations (store, delete) use the public SemanticCache API normally.

Mode feature matrix (redisvl 0.18.2 feature audit):
  bare/local/full: identical — cosine threshold only.

Why bare == local == full:
  - SemanticCache ships no built-in reranker or LLM-judge hook.
  - SemanticRouter (redisvl.extensions.router) routes queries to indices;
    it is not a cache quality feature.
  - filter_expression on check() enables metadata filtering; not applicable
    here (no metadata stored).
  - LangCacheSemanticCache uses a different embedding model (redis/langcache-embed-v1)
    which breaks embedding standardization across adapters; not used.
  - No Cohere or cross-encoder integration in the library.

--debug-judge flag:
  When enabled, wires an external LLM judge (gpt-4o-mini) onto every cosine hit
  within uncertainty_band of threshold. NOT a native redisvl feature — it's a
  research overlay to measure how much a judge would help.

  redisvl 0.18.2 CacheHit (documented return shape of check()) fields:
    entry_id, prompt, response, vector_distance, inserted_at, updated_at,
    metadata, filters.
  Both `prompt` (original cached prompt) and `response` (cached response) are
  available. We pass `response` only to the judge — matching BetterDB's native
  judge which receives ctx["response"] from the package. This keeps the two
  adapters asking gpt-4o-mini an identical question so results are comparable.
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Literal

from cache_benchmark.adapters.base import CacheAdapter
from cache_benchmark.types import CheckResult

_JUDGE_UNCERTAINTY_BAND = 0.05  # judge only fires on hits within this band of threshold


class RedisVLAdapter(CacheAdapter):
    name = "redisvl"

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
        self._index_name = f"bench_redisvl_{uuid.uuid4().hex[:8]}"
        self._cache = None
        self._url = redis_url or "redis://localhost:6379"

        # redisvl_backend: "valkey" uses raw FT.SEARCH workaround (default, benchmark runs).
        # "redis-stack" uses native SemanticCache.check() via Redis Stack, for fair comparison.
        self._redisvl_backend: str = kwargs.get("redisvl_backend", "valkey")
        if self._redisvl_backend == "redis-stack":
            self._url = os.environ.get("REDIS_STACK_URL", "redis://localhost:6383")
            self._index_name = f"bench_redisvl_rs_{uuid.uuid4().hex[:8]}"

        # Profiling hooks (set externally by latency_profile.py)
        self._profile_timing: dict = {}

        self._debug_judge: bool = kwargs.get("debug_judge", False)
        self._judge_log_writer = kwargs.get("judge_log_writer", None)
        self._openai_key: str | None = None
        if self._debug_judge:
            self._openai_key = os.environ.get("OPENAI_API_KEY")
            if not self._openai_key:
                raise EnvironmentError(
                    "[redisvl --debug-judge] OPENAI_API_KEY is required. "
                    "Set it in your environment or omit --debug-judge."
                )

    def enabled_features(self) -> list[str]:
        features = [
            "cosine-distance threshold",
            "NOT enabled: rerank (not available in redisvl 0.18.2 SemanticCache)",
            "NOT enabled: Cohere rerank (not available in redisvl 0.18.2 SemanticCache)",
            "NOT enabled: SemanticRouter (query routing, not a cache quality feature)",
            "NOTE: bare == local == full for redisvl; no native quality features beyond cosine threshold",
        ]
        if self._debug_judge:
            features.insert(1,
                f"external LLM judge (gpt-4o-mini) on uncertain hits "
                f"(cosine distance within {_JUDGE_UNCERTAINTY_BAND} of threshold), "
                "receives (query, cached_response) matching BetterDB's native judge — "
                "not a native redisvl feature, enabled via --debug-judge for research only"
            )
        else:
            features.insert(1, "NOT enabled: LLM-as-judge (not available in redisvl 0.18.2 SemanticCache)")
        return features

    def _build_cache(self, overwrite: bool = False):
        from redisvl.extensions.cache.llm import SemanticCache  # type: ignore
        from redisvl.utils.vectorize import HFTextVectorizer  # type: ignore

        vectorizer = HFTextVectorizer(model=self.embedding_model)
        return SemanticCache(
            name=self._index_name,
            vectorizer=vectorizer,
            distance_threshold=self.threshold,
            redis_url=self._url,
            overwrite=overwrite,
        )

    def _raw_client(self):
        return self._cache._index._redis_client

    def _drop_index_raw(self):
        """Drop the FT index using raw command (redisvl's delete() has arg-count issues with Valkey)."""
        try:
            self._raw_client().execute_command("FT.DROPINDEX", self._index_name)
        except Exception:
            pass
        cursor = 0
        while True:
            cursor, keys = self._raw_client().scan(cursor, match=f"{self._index_name}:*", count=500)
            if keys:
                self._raw_client().delete(*keys)
            if cursor == 0:
                break

    async def initialize(self) -> None:
        # Always overwrite: harness calls clear() before initialize(), and on
        # first use there is nothing to overwrite. This avoids from_existing()
        # which crashes on Valkey Search's FT.INFO response format.
        self._cache = self._build_cache(overwrite=True)

    async def store(self, prompt: str, response: str) -> None:
        self._cache.store(prompt=prompt, response=response)

    async def _invoke_judge(
        self, prompt_b: str, cached_response: str, distance: float
    ) -> tuple[str, str]:
        """Call gpt-4o-mini to decide match/nomatch. Returns (verdict, raw_response).

        Prompt format is structurally identical to BetterDB's native judge
        (betterdb.py lines 101-105) so both adapters ask the model the same question.
        Uses cached_response only (not cached_prompt), matching BetterDB's ctx shape.
        """
        try:
            from openai import AsyncOpenAI  # type: ignore
            client = AsyncOpenAI(api_key=self._openai_key)
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
                            f"New query: {prompt_b}\n\n"
                            f"Cached response: {str(cached_response)[:500]}\n\n"
                            "Is the cached response an acceptable answer to the new query?"
                        ),
                    },
                ],
                max_tokens=5,
                temperature=0,
            )
            raw = resp.choices[0].message.content.strip()
            verdict = "match" if raw.upper().startswith("Y") else "nomatch"
            return verdict, raw
        except Exception as e:
            return "error", str(e)

    async def check(self, prompt: str) -> CheckResult:
        if self._redisvl_backend == "redis-stack":
            return await self._check_native(prompt)
        return await self._check_valkey_workaround(prompt)

    async def _check_native(self, prompt: str) -> CheckResult:
        """Native redisvl check() path — only works correctly on Redis Stack."""
        t0 = time.perf_counter()

        t_embed0 = time.perf_counter_ns()
        # _vectorize_prompt is synchronous; timing it gives pure embed cost
        vector = self._cache._vectorize_prompt(prompt)
        embed_ns = time.perf_counter_ns() - t_embed0

        t_search0 = time.perf_counter_ns()
        try:
            results = self._cache.check(prompt=prompt, num_results=1)
        except Exception as e:
            raise RuntimeError(
                f"RedisVL native check() failed on Redis Stack. "
                f"Ensure redis-stack-bench is running: "
                f"docker run -d --name redis-stack-bench -p 6383:6379 redis/redis-stack-server:latest\n"
                f"Original error: {e}"
            ) from e
        search_ns = time.perf_counter_ns() - t_search0

        latency_ms = (time.perf_counter() - t0) * 1000
        self._profile_timing = {
            "embed_ms": embed_ns / 1e6,
            "network_ms": search_ns / 1e6,
            "parse_ms": latency_ms - embed_ns / 1e6 - search_ns / 1e6,
        }

        if not results:
            return CheckResult(hit=False, latency_ms=latency_ms)

        r = results[0]
        distance = r.get("vector_distance")
        if distance is not None and float(distance) > self.threshold:
            return CheckResult(hit=False, similarity_score=float(distance), latency_ms=latency_ms)

        return CheckResult(
            hit=True,
            cached_response=r.get("response"),
            similarity_score=float(distance) if distance is not None else None,
            latency_ms=latency_ms,
        )

    async def _check_valkey_workaround(self, prompt: str) -> CheckResult:
        """Raw FT.SEARCH workaround — required for Valkey Search compatibility."""
        import struct
        from redisvl.extensions.cache.llm.semantic import (  # type: ignore
            CACHE_VECTOR_FIELD_NAME,
            RESPONSE_FIELD_NAME,
            PROMPT_FIELD_NAME,
        )

        t0 = time.perf_counter()

        # Identical across all modes — redisvl has no quality features to enable.
        t_embed0 = time.perf_counter_ns()
        vector = self._cache._vectorize_prompt(prompt)
        embed_ns = time.perf_counter_ns() - t_embed0
        vec_bytes = struct.pack(f"{len(vector)}f", *vector)

        t_search0 = time.perf_counter_ns()
        raw = self._raw_client().ft(self._index_name).search(
            f"*=>[KNN 1 @{CACHE_VECTOR_FIELD_NAME} $vec AS __dist]",
            query_params={"vec": vec_bytes},
        )
        search_ns = time.perf_counter_ns() - t_search0
        latency_ms = (time.perf_counter() - t0) * 1000

        self._profile_timing = {
            "embed_ms": embed_ns / 1e6,
            "network_ms": search_ns / 1e6,
            "parse_ms": latency_ms - embed_ns / 1e6 - search_ns / 1e6,
        }

        if not raw.docs:
            return CheckResult(hit=False, latency_ms=latency_ms)

        doc = raw.docs[0]
        distance = float(getattr(doc, "__dist", 1.0))

        if distance > self.threshold:
            return CheckResult(hit=False, similarity_score=distance, latency_ms=latency_ms)

        cached_prompt = getattr(doc, PROMPT_FIELD_NAME, None)
        cached_response = getattr(doc, RESPONSE_FIELD_NAME, None)

        # --debug-judge: invoke an external LLM judge on cosine hits that fall
        # within _JUDGE_UNCERTAINTY_BAND of the threshold. This is NOT a native
        # redisvl feature; it is an investigation overlay. The verdict changes
        # the hit/miss outcome and every invocation is written to the JSONL log.
        if self._debug_judge and distance >= (self.threshold - _JUDGE_UNCERTAINTY_BAND):
            verdict, raw_response = await self._invoke_judge(
                prompt_b=prompt,
                cached_response=cached_response or "",
                distance=distance,
            )
            if self._judge_log_writer is not None:
                self._judge_log_writer({
                    # prompt_a = cached response (matches BetterDB log convention;
                    # cached_prompt is also available from the doc but not used here)
                    "prompt_a": cached_response or "",
                    "prompt_b": prompt,
                    "similarity_score": distance,
                    "judge_verdict": verdict,
                    "judge_raw_response": raw_response,
                })
            if verdict == "nomatch":
                return CheckResult(hit=False, similarity_score=distance, latency_ms=latency_ms)

        return CheckResult(
            hit=True,
            cached_response=cached_response,
            similarity_score=distance,
            latency_ms=latency_ms,
        )

    async def clear(self) -> None:
        if self._cache is not None:
            self._drop_index_raw()

    async def close(self) -> None:
        if self._cache is not None:
            self._drop_index_raw()
