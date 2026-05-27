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
  bare:    cosine-distance threshold only.
  local:   k=3 candidates + keyword-overlap rerank. No external APIs.
  full:    k=3 candidates + keyword-overlap rerank + LLM-as-judge (OpenAI gpt-4o-mini).
           Requires OPENAI_API_KEY. Judge fires only on uncertain hits (within uncertainty_band).
  autotune: Monitor-driven threshold autotuning via propose + auto-approve API.
           Threshold evolves during the run; trajectory logged per check.
           Requires BETTERDB_URL, BETTERDB_TOKEN, BETTERDB_INSTANCE_ID.

Not available in any mode:
  - per-category thresholds: API exists but dataset has no categories.

Autotune implementation (mirrors chat.betterdb.com app/api/optimize/route.ts):
  Monitor REST API (propose + auto-approve):
    1. GET  /mcp/instance/{id}/caches/{name}/threshold-recommendation
    2. POST /mcp/instance/{id}/cache-proposals/threshold-adjust → proposal_id
    3. POST /mcp/cache-proposals/{proposal_id}/approve → applied
  The approved threshold is written to {name}:__config by the Monitor.
  configRefresh (enabled, 1s interval) picks it up on the next poll.
  Monitor prefix (/api vs /) is auto-detected at startup (mirrors monitor-client.ts).

  References (chat.betterdb.com repo):
  - lib/cache.ts:43-45: configRefresh wires the Python package's _default_threshold update
    mechanism; when Monitor approves a proposal it writes to {name}:__config and configRefresh
    polls every 30s to pick it up.
  - app/api/optimize/route.ts:56-75: system prompt — recommends threshold when
    sample_count >= 100; proposes + immediately approves threshold changes.
  - app/api/optimize/route.ts:165-181: propose_threshold_adjust writes to {name}:__config
    via Monitor's CacheProposalMcpController.
  - app/api/optimize/route.ts:210-218: approve_proposal applies the change (also writes
    to {name}:__config). configRefresh in the running process then picks it up.
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Literal
from urllib.parse import quote as urlquote

from cache_benchmark.adapters.base import CacheAdapter
from cache_benchmark.types import CheckResult

# Autotune constants.
# Evaluation interval: how often to poll the Monitor for a recommendation.
# Min samples: mirrors the /api/optimize system prompt "sample_count >= 100" guard
#   (chat.betterdb.com app/api/optimize/route.ts:57).
_AUTOTUNE_EVAL_INTERVAL = 100
_AUTOTUNE_MIN_SAMPLES = 100
# Clamp bounds: mirrors Monitor proposal validation (route.ts:172: min(0.02).max(0.3))
_AUTOTUNE_MIN_THRESHOLD = 0.02
_AUTOTUNE_MAX_THRESHOLD = 0.30


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

        # The cached response is "Answer: {original_prompt}", so extract the
        # original prompt for a fair semantic comparison.
        cached_response = str(ctx.get('response', ''))
        original_text = cached_response.removeprefix("Answer: ") if cached_response.startswith("Answer: ") else cached_response
        new_text = ctx.get('prompt', '')

        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a semantic equivalence judge for a cache. "
                        "Say YES if the two texts are about the same thing — same topic, "
                        "same action, same core meaning. Rephrasings, added/missing minor "
                        "details (adjectives, extra context), and grammatical variations "
                        "all count as equivalent. Say NO only if the texts describe "
                        "fundamentally different events, topics, or meanings. "
                        "Answer only YES or NO."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Text A: {original_text}\n\n"
                        f"Text B: {new_text}\n\n"
                        "Are these two texts semantically equivalent?"
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
        mode: Literal["bare", "local", "full", "autotune", "autotune-full"] = "bare",
        **kwargs,
    ) -> None:
        super().__init__(threshold=threshold, embedding_model=embedding_model, redis_url=redis_url, mode=mode)
        self._cache_name = f"bench:betterdb:{uuid.uuid4().hex[:8]}"
        self._cache = None
        self._client = None

        self._debug_judge = kwargs.get("debug_judge", False)
        self._judge_log_writer = kwargs.get("judge_log_writer", None)
        self._trajectory_writer = kwargs.get("trajectory_writer", None)

        # Autotune state
        self._check_count: int = 0
        self._last_recommendation: str = "insufficient_data"

        self._betterdb_url: str | None = None
        self._betterdb_token: str | None = None
        self._betterdb_instance_id: str | None = None
        self._monitor_base: str | None = None  # resolved during initialize()
        if mode in ("autotune", "autotune-full"):
            self._betterdb_url = os.environ.get("BETTERDB_URL", "").rstrip("/")
            self._betterdb_token = os.environ.get("BETTERDB_TOKEN", "")
            self._betterdb_instance_id = os.environ.get("BETTERDB_INSTANCE_ID", "")
            if not all([self._betterdb_url, self._betterdb_token, self._betterdb_instance_id]):
                raise EnvironmentError(
                    "[betterdb autotune] BETTERDB_URL, BETTERDB_TOKEN, and BETTERDB_INSTANCE_ID "
                    "must all be set to use the Monitor API for proposal creation and auto-approval.\n"
                    "  BETTERDB_URL          Monitor base URL (e.g. https://betterdb-test1.app.betterdb.com)\n"
                    "  BETTERDB_TOKEN        MCP bearer token from Monitor → Settings → Tokens\n"
                    "  BETTERDB_INSTANCE_ID  Valkey connection ID shown in the Monitor dashboard\n"
                    "Also ensure the agent is running:\n"
                    "  docker run -d --name betterdb-agent --network host \\\n"
                    "    -e VALKEY_HOST=127.0.0.1 -e VALKEY_PORT=6381 \\\n"
                    "    -e BETTERDB_CLOUD_URL=... -e BETTERDB_TOKEN=... \\\n"
                    "    betterdb/agent:1.4.0"
                )

        self._openai_key = None
        if mode in ("full", "autotune-full"):
            self._openai_key = os.environ.get("OPENAI_API_KEY")
            if not self._openai_key:
                raise EnvironmentError(
                    f"[betterdb {mode} mode] OPENAI_API_KEY is required for the LLM-as-judge gate. "
                    "Set it in your environment or use --mode autotune (threshold only, no API key needed)."
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
        if self.mode == "autotune":
            return [
                f"initial cosine-distance threshold: {self.threshold}",
                f"Monitor-driven autotuning via proposal + auto-approve API (every {_AUTOTUNE_EVAL_INTERVAL} checks)",
                f"  GET  .../threshold-recommendation (min_samples={_AUTOTUNE_MIN_SAMPLES})",
                f"  POST .../cache-proposals/threshold-adjust → POST .../approve",
                "tunes: global cosine-distance threshold only",
                "discovery: enabled — cache visible to BetterDB agent and Monitor dashboard",
                "configRefresh: enabled (1s interval) — picks up approved threshold changes",
                "NOT enabled: rerank, LLM judge (autotune mode is bare cosine + threshold evolution)",
                "NOT enabled: per-category thresholds (dataset has no categories)",
            ]
        if self.mode == "autotune-full":
            return [
                f"initial cosine-distance threshold: {self.threshold}",
                f"Monitor-driven autotuning via proposal + auto-approve API (every {_AUTOTUNE_EVAL_INTERVAL} checks)",
                "top-3 candidate retrieval (k=3)",
                "keyword-overlap rerank (cosine 70% + word-overlap 30%)",
                "LLM-as-judge gate on uncertain hits (gpt-4o-mini, uncertainty_band=0.05)",
                "discovery: enabled — cache visible to BetterDB agent and Monitor dashboard",
                "configRefresh: enabled (1s interval) — picks up approved threshold changes",
            ]
        # full
        return [
            "cosine-distance threshold",
            "top-3 candidate retrieval (k=3)",
            "keyword-overlap rerank (cosine 70% + word-overlap 30%)",
            "LLM-as-judge gate on uncertain hits (gpt-4o-mini, uncertainty_band=0.05)",
            "NOT enabled: per-category thresholds (dataset has no categories)",
        ]

    @property
    def current_threshold(self) -> float:
        """The effective threshold currently in use, which may differ from the initial
        value when autotuning has applied one or more updates."""
        if self._cache is None:
            return self.threshold
        return self._cache._default_threshold

    async def _detect_monitor_base(self) -> str:
        """Probe the Monitor to find whether it's behind /api (deployed) or / (local dev).

        Mirrors chat.betterdb.com lib/monitor-client.ts detectPrefix().
        """
        import httpx

        headers = {"Authorization": f"Bearer {self._betterdb_token}"}
        async with httpx.AsyncClient(timeout=5.0) as http:
            for prefix in ("/api", ""):
                try:
                    resp = await http.get(
                        f"{self._betterdb_url}{prefix}/mcp/instances",
                        headers=headers,
                    )
                    if resp.status_code == 200:
                        return f"{self._betterdb_url}{prefix}"
                    if resp.status_code == 401:
                        raise EnvironmentError(
                            "BetterDB Monitor rejected the token (401) — check BETTERDB_TOKEN"
                        )
                except httpx.HTTPError:
                    continue
        raise EnvironmentError(
            "BetterDB Monitor not reachable — check BETTERDB_URL and BETTERDB_TOKEN"
        )

    async def initialize(self) -> None:
        import valkey.asyncio as valkey  # type: ignore
        from betterdb_semantic_cache import SemanticCache  # type: ignore
        from betterdb_semantic_cache.types import (  # type: ignore
            SemanticCacheOptions, AnalyticsOptions, DiscoveryOptions, ConfigRefreshOptions,
        )

        url = self.redis_url or "redis://localhost:6379"
        self._client = valkey.Valkey.from_url(url, decode_responses=False)
        embed_fn = _make_sbert_embed_fn(self.embedding_model)

        # In autotune modes, detect the Monitor API base URL (with or without /api prefix)
        # before starting the benchmark so we fail fast on misconfiguration.
        is_autotune = self.mode in ("autotune", "autotune-full")
        if is_autotune:
            self._monitor_base = await self._detect_monitor_base()
        opts = SemanticCacheOptions(
            client=self._client,
            embed_fn=embed_fn,
            name=self._cache_name,
            default_threshold=self.threshold,
            analytics=AnalyticsOptions(disabled=not is_autotune),
            discovery=DiscoveryOptions(enabled=is_autotune),
            # 1s interval: short enough that a cloud Monitor threshold change is visible
            # within the next few check() calls even on a fast benchmark run.
            config_refresh=ConfigRefreshOptions(enabled=is_autotune, interval_ms=30_000),
        )
        self._cache = SemanticCache(opts)
        await self._cache.initialize()

        # Seed the __config key with the initial threshold so the Monitor's
        # readSemanticConfig reads the correct value instead of falling back
        # to DEFAULT_SEMANTIC_THRESHOLD (0.10).
        if is_autotune:
            await self._client.hset(
                self._cache._config_key,
                mapping={"threshold": str(self.threshold)},
            )

    async def store(self, prompt: str, response: str) -> None:
        await self._cache.store(prompt, response)

    async def _run_optimization_cycle(self) -> None:
        """Poll the Monitor for a threshold recommendation, propose + auto-approve.

        Mirrors the chat.betterdb.com optimize agent (app/api/optimize/route.ts):
          1. GET  .../threshold-recommendation → recommendation + recommended_threshold
          2. POST .../cache-proposals/threshold-adjust → proposal_id
          3. POST .../cache-proposals/{proposal_id}/approve → applied

        The approved threshold is written to {name}:__config by the Monitor.
        configRefresh (enabled with 1s interval) picks it up on the next poll.
        """
        import httpx  # lazy import — only needed in autotune mode

        enc_cache = urlquote(self._cache_name, safe="")
        headers = {"Authorization": f"Bearer {self._betterdb_token}", "Content-Type": "application/json"}

        async with httpx.AsyncClient(base_url=self._monitor_base, timeout=30.0) as http:

            async def _request(method: str, path: str, **kwargs) -> httpx.Response:
                """Send request with retry on 429 and transient errors."""
                for attempt in range(4):
                    try:
                        resp = await http.request(method, path, **kwargs)
                    except httpx.TimeoutException:
                        if attempt < 3:
                            await asyncio.sleep(2 ** attempt)
                            continue
                        raise
                    if resp.status_code != 429:
                        return resp
                    wait = float(resp.headers.get("retry-after", 2 ** attempt))
                    await asyncio.sleep(wait)
                return resp  # last attempt, let caller handle status

            # 1. Get threshold recommendation from Monitor
            rec_resp = await _request(
                "GET",
                f"/mcp/instance/{self._betterdb_instance_id}"
                f"/caches/{enc_cache}/threshold-recommendation"
                f"?minSamples={_AUTOTUNE_MIN_SAMPLES}",
                headers=headers,
            )
            # 404 = cache not yet discovered by Monitor — treat as insufficient_data
            if rec_resp.status_code in (404, 429):
                self._last_recommendation = "cache_not_discovered" if rec_resp.status_code == 404 else "rate_limited"
                return
            rec_resp.raise_for_status()
            rec_data = rec_resp.json()

            self._last_recommendation = rec_data.get("recommendation", "insufficient_data")

            if not (
                self._last_recommendation in ("tighten_threshold", "loosen_threshold")
                and rec_data.get("sample_count", 0) >= _AUTOTUNE_MIN_SAMPLES
                and rec_data.get("recommended_threshold") is not None
            ):
                return

            new_threshold = float(rec_data["recommended_threshold"])
            new_threshold = max(_AUTOTUNE_MIN_THRESHOLD, min(_AUTOTUNE_MAX_THRESHOLD, new_threshold))

            reasoning = (
                f"Autotune: {self._last_recommendation} from "
                f"{self.current_threshold:.4f} to {new_threshold:.4f} "
                f"(sample_count={rec_data.get('sample_count', '?')})"
            )

            # 2. Propose threshold adjustment
            propose_resp = await _request(
                "POST",
                f"/mcp/instance/{self._betterdb_instance_id}"
                f"/cache-proposals/threshold-adjust",
                headers=headers,
                json={
                    "cache_name": self._cache_name,
                    "new_threshold": new_threshold,
                    "reasoning": reasoning,
                    "category": None,
                },
            )
            if propose_resp.status_code == 429:
                return  # skip this cycle, try next time
            propose_resp.raise_for_status()
            proposal_id = propose_resp.json().get("proposal_id") or propose_resp.json().get("id")

            if not proposal_id:
                return

            # 3. Auto-approve the proposal
            approve_resp = await _request(
                "POST",
                f"/mcp/cache-proposals/{proposal_id}/approve",
                headers=headers,
                json={"actor": "cache-benchmark-autotune"},
            )
            if approve_resp.status_code == 429:
                return  # proposal exists but unapproved; configRefresh may pick it up later
            approve_resp.raise_for_status()

            # configRefresh will pick up the change; force an immediate refresh
            await self._cache.refresh_config()

    async def check(self, prompt: str) -> CheckResult:
        from betterdb_semantic_cache.types import CacheCheckOptions, RerankOptions, JudgeOptions  # type: ignore

        t0 = time.perf_counter()

        if self.mode == "bare":
            result = await self._cache.check(prompt)
        elif self.mode == "autotune":
            result = await self._cache.check(prompt)
        elif self.mode == "local":
            opts = CacheCheckOptions(
                k=3,
                rerank=RerankOptions(k=3, rerank_fn=_make_keyword_overlap_rerank_fn()),
            )
            result = await self._cache.check(prompt, options=opts)
        else:  # full or autotune-full
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

        if self.mode in ("autotune", "autotune-full"):
            self._check_count += 1
            # Log trajectory BEFORE potential threshold update so the record reflects
            # the threshold that was active during this check.
            if self._trajectory_writer is not None:
                self._trajectory_writer({
                    "query_index": self._check_count,
                    "effective_threshold": self.current_threshold,
                    "hit": result.hit,
                    "recommendation": self._last_recommendation,
                })
            # Ask the Monitor for a recommendation and auto-approve the proposal.
            if self._check_count % _AUTOTUNE_EVAL_INTERVAL == 0:
                await self._run_optimization_cycle()

        return CheckResult(
            hit=result.hit,
            cached_response=result.response if result.hit else None,
            similarity_score=result.similarity,
            latency_ms=latency_ms,
        )

    async def clear(self) -> None:
        if self._cache is not None:
            await self._cache.flush()
            # Reset the config key to the initial threshold so the next sweep
            # starts clean, not from the last auto-approved value.
            # Also clear tuning history so velocity dampening starts fresh.
            if self._client is not None:
                await self._client.delete(self._cache._config_key)
                await self._client.delete(f"{self._cache_name}:__tuning_history")
                await self._client.hset(
                    self._cache._config_key,
                    mapping={"threshold": str(self.threshold)},
                )
            await self._cache.initialize()
        # Reset autotune state so each threshold sweep starts from a clean baseline.
        self._check_count = 0
        self._last_recommendation = "insufficient_data"

    async def close(self) -> None:
        if self._cache is not None:
            await self._cache.shutdown()
        if self._client is not None:
            await self._client.aclose()
