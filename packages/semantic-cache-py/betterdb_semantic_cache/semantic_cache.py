from __future__ import annotations

import asyncio
import hashlib
import json
import math
import time
import uuid
from typing import Any

from opentelemetry.trace import StatusCode

from .analytics import NOOP_ANALYTICS, Analytics, create_analytics
from .cluster import cluster_scan
from .default_cost_table import DEFAULT_COST_TABLE
from .errors import EmbeddingError, SemanticCacheUsageError, ValkeyCommandError
from .telemetry import Telemetry, create_telemetry
from .types import (
    AnalyticsOptions,
    CacheCheckOptions,
    CacheCheckResult,
    CacheStats,
    EmbedFn,
    IndexInfo,
    InvalidateResult,
    ModelCost,
    NearestMiss,
    SemanticCacheOptions,
    ThresholdEffectivenessResult,
)
from .normalizer import BinaryNormalizer, default_normalizer
from .utils import ContentBlock, encode_float32, decode_float32, escape_tag, extract_binary_refs, extract_text, parse_ft_search_response

INVALIDATE_BATCH_SIZE = 1000


class SemanticCache:
    """Semantic cache backed by Valkey vector search (FT.SEARCH KNN).

    The caller owns the valkey client lifecycle. SemanticCache does not
    close or disconnect the client when it is done.

    Call initialize() before using check() or store().
    """

    def __init__(self, options: SemanticCacheOptions) -> None:
        self._client = options.client
        self._embed_fn: EmbedFn = options.embed_fn
        self._name = options.name
        self._index_name = f"{options.name}:idx"
        self._entry_prefix = f"{options.name}:entry:"
        self._stats_key = f"{options.name}:__stats"
        self._similarity_window_key = f"{options.name}:__similarity_window"
        self._embed_key_prefix = f"{options.name}:embed:"
        self._default_threshold = options.default_threshold
        self._default_ttl = options.default_ttl
        self._category_thresholds = options.category_thresholds
        self._uncertainty_band = options.uncertainty_band

        # Build effective cost table
        if not options.use_default_cost_table and not options.cost_table:
            self._cost_table: dict[str, ModelCost] | None = None
        elif not options.use_default_cost_table:
            self._cost_table = dict(options.cost_table)
        else:
            self._cost_table = {**DEFAULT_COST_TABLE, **options.cost_table}

        # Embedding cache config
        self._embedding_cache_enabled = options.embedding_cache.enabled
        self._embedding_cache_ttl = options.embedding_cache.ttl

        # Store normalizer as a public attribute so users can pass it to
        # adapter prepare_semantic_params() calls to share the same strategy.
        # It is not used internally by SemanticCache — normalization happens at
        # the adapter level before ContentBlocks are created.
        self.normalizer: BinaryNormalizer = options.normalizer or default_normalizer

        self._telemetry: Telemetry = create_telemetry(
            prefix=options.telemetry.metrics_prefix,
            tracer_name=options.telemetry.tracer_name,
            registry=options.telemetry.registry,
        )

        self._initialized = False
        self._dimension = 0
        self._has_binary_refs = False
        self._init_lock = asyncio.Lock()

        # Analytics
        self._analytics_opts: AnalyticsOptions = options.analytics
        self._uses_default_cost_table = options.use_default_cost_table
        self._analytics: Analytics = NOOP_ANALYTICS
        self._stats_task: asyncio.Task[None] | None = None
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._shutdown = False
        self._analytics_initiated = False

    # -- Lifecycle --

    async def initialize(self) -> None:
        """Create or attach to the vector index. Must be called before check()/store()."""
        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return
            await self._do_initialize()

    async def flush(self) -> None:
        """Drop the index and delete all cached entries and embeddings.

        Marks the cache as uninitialized immediately so concurrent check()/store()
        calls get a clear SemanticCacheUsageError instead of cryptic Valkey errors.
        """
        self._initialized = False

        # Cancel the periodic stats task — stats() calls _assert_initialized() which
        # would raise and be swallowed by the loop, wasting event-loop cycles until
        # initialize() or shutdown() is called.
        if self._stats_task is not None:
            self._stats_task.cancel()
            self._stats_task = None

        try:
            await self._client.execute_command("FT.DROPINDEX", self._index_name)
        except Exception as err:
            if not self._is_index_not_found_error(err):
                raise ValkeyCommandError("FT.DROPINDEX", err)

        async def _del(keys: list[str], node_client: Any) -> None:
            # Use a pipeline of individual per-key DEL commands instead of a
            # single multi-key DEL. Multi-key DEL causes CROSSSLOT errors in
            # cluster mode when keys from one SCAN batch span different hash slots.
            pipe = node_client.pipeline()
            for key in keys:
                pipe.delete(key)
            try:
                await pipe.execute()
            except Exception as exc:
                raise ValkeyCommandError("DEL", exc) from exc

        for pattern in [f"{self._name}:entry:*", f"{self._name}:embed:*"]:
            await cluster_scan(self._client, pattern, _del)

        await self._client.delete(self._stats_key)
        await self._client.delete(self._similarity_window_key)
        self._analytics.capture("cache_flush")

    async def shutdown(self) -> None:
        """Shut down the analytics client and cancel the stats timer."""
        self._shutdown = True
        if self._stats_task is not None:
            self._stats_task.cancel()
            self._stats_task = None
        await self._analytics.shutdown()

    # -- Public operations --

    async def check(
        self,
        prompt: str | list[ContentBlock],
        options: CacheCheckOptions | None = None,
    ) -> CacheCheckResult:
        self._assert_initialized("check")
        opts = options or CacheCheckOptions()

        async def _run(span: Any) -> CacheCheckResult:
            category = opts.category or ""
            threshold = opts.threshold
            if threshold is None:
                if category and category in self._category_thresholds:
                    threshold = self._category_thresholds[category]
                else:
                    threshold = self._default_threshold

            prompt_text, binary_refs = self._resolve_prompt(prompt)
            check_stale = opts.stale_after_model_change and bool(opts.current_model)
            rerank_opts = opts.rerank
            k = rerank_opts.k if rerank_opts else opts.k

            vector, embed_sec = await self._embed(prompt_text)
            self._assert_dimension(vector)

            user_filter = opts.filter
            if binary_refs and self._has_binary_refs:
                if len(binary_refs) == 1:
                    binary_filter: str | None = f"@binary_refs:{{{escape_tag(binary_refs[0])}}}"
                else:
                    # AND semantics: chain separate TAG clauses so all refs must be present
                    binary_filter = " ".join(
                        f"@binary_refs:{{{escape_tag(r)}}}" for r in binary_refs
                    )
            else:
                binary_filter = None
            combined = " ".join(f for f in [user_filter, binary_filter] if f)
            filter_expr = f"({combined})" if combined else "*"
            query = f"{filter_expr}=>[KNN {k} @embedding $vec AS __score]"

            search_start = time.perf_counter()
            try:
                raw_result = await self._client.execute_command(
                    "FT.SEARCH", self._index_name, query,
                    "PARAMS", "2", "vec", encode_float32(vector),
                    "LIMIT", "0", str(k),
                    "DIALECT", "2",
                )
            except Exception as err:
                raise ValkeyCommandError("FT.SEARCH", err)
            search_ms = (time.perf_counter() - search_start) * 1000

            parsed = parse_ft_search_response(raw_result)
            category_label = category or "none"
            timing_attrs = {"embedding_latency_ms": embed_sec * 1000, "search_latency_ms": search_ms}

            if not parsed:
                await self._record_stat("misses")
                self._telemetry.metrics.requests_total.labels(
                    cache_name=self._name, result="miss", category=category_label
                ).inc()
                _set_span_attrs(span, {"cache.hit": False, "cache.name": self._name,
                                        "cache.category": category_label, **timing_attrs})
                return CacheCheckResult(hit=False, confidence="miss")

            score_str = parsed[0]["fields"].get("__score")
            try:
                score = float(score_str) if score_str is not None else float("nan")
            except (ValueError, TypeError):
                score = float("nan")

            if not math.isnan(score):
                self._telemetry.metrics.similarity_score.labels(
                    cache_name=self._name, category=category_label
                ).observe(score)

            if math.isnan(score) or score > threshold:
                if not math.isnan(score):
                    await self._record_similarity_window(score, "miss", category)
                await self._record_stat("misses")
                self._telemetry.metrics.requests_total.labels(
                    cache_name=self._name, result="miss", category=category_label
                ).inc()
                _set_span_attrs(span, {"cache.hit": False, "cache.name": self._name,
                                        "cache.category": category_label, **timing_attrs})
                result = CacheCheckResult(hit=False, confidence="miss")
                if not math.isnan(score):
                    result.similarity = score
                    result.nearest_miss = NearestMiss(
                        similarity=score, delta_to_threshold=score - threshold
                    )
                return result

            # Rerank
            winner_parsed_index = 0
            if rerank_opts and parsed:
                # Preserve the original parsed[] index alongside each candidate so
                # we can map back even when NaN-scored entries are filtered out.
                indexed_candidates = [
                    (i, {"response": r["fields"].get("response", ""),
                         "similarity": _safe_float(r["fields"].get("__score"))})
                    for i, r in enumerate(parsed)
                    if not math.isnan(_safe_float(r["fields"].get("__score")))
                ]
                picked = await rerank_opts.rerank_fn(
                    prompt_text, [c for _, c in indexed_candidates]
                )
                if picked == -1:
                    # Record the actual outcome — rerank rejected, so it's a miss
                    await self._record_similarity_window(score, "miss", category)
                    await self._record_stat("misses")
                    self._telemetry.metrics.requests_total.labels(
                        cache_name=self._name, result="miss", category=category_label
                    ).inc()
                    _set_span_attrs(span, {"cache.hit": False, "cache.name": self._name, "cache.reranked": True})
                    return CacheCheckResult(hit=False, confidence="miss")
                # Validate bounds: rerank_fn is caller-supplied and could return out-of-range
                if not (0 <= picked < len(indexed_candidates)):
                    await self._record_similarity_window(score, "miss", category)
                    await self._record_stat("misses")
                    self._telemetry.metrics.requests_total.labels(
                        cache_name=self._name, result="miss", category=category_label
                    ).inc()
                    return CacheCheckResult(hit=False, confidence="miss")
                # Map back to the original parsed[] index (not the candidates[] index)
                winner_parsed_index = indexed_candidates[picked][0]

            winner = parsed[winner_parsed_index] if winner_parsed_index < len(parsed) else parsed[0]
            winner_score = _safe_float(winner["fields"].get("__score"), score)

            # Stale model check
            if check_stale:
                stored_model = winner["fields"].get("model", "")
                if stored_model and stored_model != opts.current_model:
                    try:
                        await self._client.delete(winner["key"])
                    except Exception:
                        pass
                    await self._record_similarity_window(winner_score, "miss", category)
                    self._telemetry.metrics.stale_model_evictions.labels(
                        cache_name=self._name
                    ).inc()
                    await self._record_stat("misses")
                    self._telemetry.metrics.requests_total.labels(
                        cache_name=self._name, result="miss", category=category_label
                    ).inc()
                    _set_span_attrs(span, {"cache.hit": False, "cache.stale_evicted": True})
                    return CacheCheckResult(hit=False, confidence="miss")

            # All checks passed — record as a genuine hit
            await self._record_similarity_window(winner_score, "hit", category)
            confidence = "uncertain" if winner_score >= threshold - self._uncertainty_band else "high"
            await self._record_stat("hits")
            metric_result = "uncertain_hit" if confidence == "uncertain" else "hit"
            self._telemetry.metrics.requests_total.labels(
                cache_name=self._name, result=metric_result, category=category_label
            ).inc()

            matched_key = winner["key"]
            if self._default_ttl is not None and matched_key:
                await self._client.expire(matched_key, self._default_ttl)

            cost_saved: float | None = None
            cost_micros_str = winner["fields"].get("cost_micros")
            if cost_micros_str:
                try:
                    cost_micros = int(cost_micros_str)
                    if cost_micros > 0:
                        cost_saved = cost_micros / 1_000_000
                        try:
                            await self._client.hincrby(self._stats_key, "cost_saved_micros", cost_micros)
                        except Exception:
                            pass  # best-effort stat write — never fail a valid hit
                        self._telemetry.metrics.cost_saved_total.labels(
                            cache_name=self._name, category=category_label
                        ).inc(cost_saved)
                except (ValueError, TypeError):
                    pass

            content_blocks = None
            content_blocks_str = winner["fields"].get("content_blocks")
            if content_blocks_str:
                try:
                    content_blocks = json.loads(content_blocks_str)
                except (json.JSONDecodeError, TypeError):
                    pass

            _set_span_attrs(span, {
                "cache.hit": True, "cache.similarity": winner_score, "cache.threshold": threshold,
                "cache.confidence": confidence, "cache.matched_key": matched_key,
                "cache.category": category_label, **timing_attrs,
            })

            result = CacheCheckResult(
                hit=True,
                response=winner["fields"].get("response"),
                similarity=winner_score,
                confidence=confidence,
                matched_key=matched_key,
            )
            if cost_saved is not None:
                result.cost_saved = cost_saved
            if content_blocks is not None:
                result.content_blocks = content_blocks
            return result

        return await self._traced("check", _run)

    async def store(
        self,
        prompt: str | list[ContentBlock],
        response: str,
        options: Any | None = None,
    ) -> str:
        self._assert_initialized("store")
        from .types import CacheStoreOptions
        opts = options or CacheStoreOptions()

        async def _run(span: Any) -> str:
            prompt_text, binary_refs = self._resolve_prompt(prompt)
            vector, embed_sec = await self._embed(prompt_text)
            self._assert_dimension(vector)

            entry_key = f"{self._entry_prefix}{uuid.uuid4()}"
            category = opts.category or ""
            model = opts.model or ""

            cost_micros: int | None = None
            if (model and opts.input_tokens is not None and opts.output_tokens is not None
                    and self._cost_table):
                pricing = self._cost_table.get(model)
                if pricing:
                    cost_micros = round(
                        (opts.input_tokens * pricing.input_per_1k / 1000
                         + opts.output_tokens * pricing.output_per_1k / 1000) * 1_000_000
                    )

            hash_fields: dict[str, Any] = {
                "prompt": prompt_text,
                "response": response,
                "model": model,
                "category": category,
                "inserted_at": str(int(time.time() * 1000)),
                "metadata": json.dumps(opts.metadata or {}),
                "embedding": encode_float32(vector),
            }

            if binary_refs:
                hash_fields["binary_refs"] = ",".join(binary_refs)
            if cost_micros is not None and cost_micros > 0:
                hash_fields["cost_micros"] = str(cost_micros)
            if opts.temperature is not None:
                hash_fields["temperature"] = str(opts.temperature)
            if opts.top_p is not None:
                hash_fields["top_p"] = str(opts.top_p)
            if opts.seed is not None:
                hash_fields["seed"] = str(opts.seed)

            try:
                await self._client.hset(entry_key, mapping=hash_fields)
            except Exception as err:
                raise ValkeyCommandError("HSET", err)

            ttl = opts.ttl if opts.ttl is not None else self._default_ttl
            if ttl is not None:
                await self._client.expire(entry_key, ttl)

            _set_span_attrs(span, {
                "cache.name": self._name, "cache.key": entry_key, "cache.ttl": ttl or -1,
                "cache.category": category or "none", "cache.model": model or "none",
                "embedding_latency_ms": embed_sec * 1000,
            })
            return entry_key

        return await self._traced("store", _run)

    async def store_multipart(
        self,
        prompt: str | list[ContentBlock],
        blocks: list[ContentBlock],
        options: Any | None = None,
    ) -> str:
        self._assert_initialized("store_multipart")
        from .types import CacheStoreOptions
        opts = options or CacheStoreOptions()

        async def _run(span: Any) -> str:
            prompt_text, binary_refs = self._resolve_prompt(prompt)
            vector, embed_sec = await self._embed(prompt_text)
            self._assert_dimension(vector)

            text_response = extract_text(blocks)  # type: ignore[arg-type]
            entry_key = f"{self._entry_prefix}{uuid.uuid4()}"
            category = opts.category or ""
            model = opts.model or ""

            cost_micros: int | None = None
            if (model and opts.input_tokens is not None and opts.output_tokens is not None
                    and self._cost_table):
                pricing = self._cost_table.get(model)
                if pricing:
                    cost_micros = round(
                        (opts.input_tokens * pricing.input_per_1k / 1000
                         + opts.output_tokens * pricing.output_per_1k / 1000) * 1_000_000
                    )

            hash_fields: dict[str, Any] = {
                "prompt": prompt_text,
                "response": text_response,
                "model": model,
                "category": category,
                "inserted_at": str(int(time.time() * 1000)),
                "metadata": json.dumps(opts.metadata or {}),
                "embedding": encode_float32(vector),
                "content_blocks": json.dumps(blocks),
            }

            if binary_refs:
                hash_fields["binary_refs"] = ",".join(binary_refs)
            if cost_micros is not None and cost_micros > 0:
                hash_fields["cost_micros"] = str(cost_micros)
            if opts.temperature is not None:
                hash_fields["temperature"] = str(opts.temperature)
            if opts.top_p is not None:
                hash_fields["top_p"] = str(opts.top_p)
            if opts.seed is not None:
                hash_fields["seed"] = str(opts.seed)

            try:
                await self._client.hset(entry_key, mapping=hash_fields)
            except Exception as err:
                raise ValkeyCommandError("HSET", err)

            ttl = opts.ttl if opts.ttl is not None else self._default_ttl
            if ttl is not None:
                await self._client.expire(entry_key, ttl)

            _set_span_attrs(span, {
                "cache.name": self._name, "cache.key": entry_key,
                "cache.category": category or "none", "embedding_latency_ms": embed_sec * 1000,
            })
            return entry_key

        return await self._traced("store_multipart", _run)

    async def check_batch(
        self,
        prompts: list[str | list[ContentBlock]],
        options: CacheCheckOptions | None = None,
    ) -> list[CacheCheckResult]:
        """Check multiple prompts concurrently using pipelined FT.SEARCH calls."""
        self._assert_initialized("check_batch")
        if not prompts:
            return []

        opts = options or CacheCheckOptions()
        if opts.rerank is not None:
            raise SemanticCacheUsageError(
                "check_batch() does not support the 'rerank' option. "
                "Use check() for reranking individual prompts."
            )
        if opts.stale_after_model_change:
            raise SemanticCacheUsageError(
                "check_batch() does not support 'stale_after_model_change'. "
                "Use check() for stale-model eviction."
            )

        async def _run(span: Any) -> list[CacheCheckResult]:
            resolved = [self._resolve_prompt(p) for p in prompts]
            embeddings = await asyncio.gather(*[self._embed(text) for text, _ in resolved])

            category = opts.category or ""
            threshold = opts.threshold
            if threshold is None:
                if category and category in self._category_thresholds:
                    threshold = self._category_thresholds[category]
                else:
                    threshold = self._default_threshold
            k = opts.k
            user_filter = opts.filter

            pipe = self._client.pipeline()
            for i in range(len(prompts)):
                _, binary_refs = resolved[i]
                vector, _ = embeddings[i]

                if binary_refs and self._has_binary_refs:
                    if len(binary_refs) == 1:
                        binary_filter: str | None = f"@binary_refs:{{{escape_tag(binary_refs[0])}}}"
                    else:
                        binary_filter = " ".join(
                            f"@binary_refs:{{{escape_tag(r)}}}" for r in binary_refs
                        )
                else:
                    binary_filter = None
                combined = " ".join(f for f in [user_filter, binary_filter] if f)
                filter_expr = f"({combined})" if combined else "*"
                query = f"{filter_expr}=>[KNN {k} @embedding $vec AS __score]"

                pipe.execute_command(
                    "FT.SEARCH", self._index_name, query,
                    "PARAMS", "2", "vec", encode_float32(vector),
                    "LIMIT", "0", str(k),
                    "DIALECT", "2",
                )

            pipeline_results = await pipe.execute(raise_on_error=False)
            _set_span_attrs(span, {"cache.batch_size": len(prompts), "cache.name": self._name})

            results: list[CacheCheckResult] = []
            category_label = category or "none"
            keys_to_expire: list[str] = []
            total_cost_micros = 0

            for i in range(len(prompts)):
                raw_result = pipeline_results[i] if pipeline_results and i < len(pipeline_results) else None
                if isinstance(raw_result, Exception) or raw_result is None:
                    await self._record_stat("misses")
                    self._telemetry.metrics.requests_total.labels(
                        cache_name=self._name, result="miss", category=category_label
                    ).inc()
                    results.append(CacheCheckResult(hit=False, confidence="miss"))
                    continue

                parsed = parse_ft_search_response(raw_result)
                if not parsed:
                    await self._record_stat("misses")
                    self._telemetry.metrics.requests_total.labels(
                        cache_name=self._name, result="miss", category=category_label
                    ).inc()
                    results.append(CacheCheckResult(hit=False, confidence="miss"))
                    continue

                score_str = parsed[0]["fields"].get("__score")
                score = _safe_float(score_str)

                if not math.isnan(score):
                    self._telemetry.metrics.similarity_score.labels(
                        cache_name=self._name, category=category_label
                    ).observe(score)

                if math.isnan(score) or score > threshold:
                    if not math.isnan(score):
                        await self._record_similarity_window(score, "miss", category)
                    await self._record_stat("misses")
                    self._telemetry.metrics.requests_total.labels(
                        cache_name=self._name, result="miss", category=category_label
                    ).inc()
                    r = CacheCheckResult(hit=False, confidence="miss")
                    if not math.isnan(score):
                        r.similarity = score
                        r.nearest_miss = NearestMiss(
                            similarity=score, delta_to_threshold=score - threshold
                        )
                    results.append(r)
                    continue

                await self._record_similarity_window(score, "hit", category)
                confidence = "uncertain" if score >= threshold - self._uncertainty_band else "high"
                await self._record_stat("hits")
                metric_result = "uncertain_hit" if confidence == "uncertain" else "hit"
                self._telemetry.metrics.requests_total.labels(
                    cache_name=self._name, result=metric_result, category=category_label
                ).inc()

                matched_key = parsed[0]["key"]
                if self._default_ttl is not None and matched_key:
                    keys_to_expire.append(matched_key)

                cost_saved: float | None = None
                cost_micros_str = parsed[0]["fields"].get("cost_micros")
                if cost_micros_str:
                    try:
                        cost_micros = int(cost_micros_str)
                        if cost_micros > 0:
                            cost_saved = cost_micros / 1_000_000
                            total_cost_micros += cost_micros
                            self._telemetry.metrics.cost_saved_total.labels(
                                cache_name=self._name, category=category_label
                            ).inc(cost_saved)
                    except (ValueError, TypeError):
                        pass

                content_blocks = None
                content_blocks_str = parsed[0]["fields"].get("content_blocks")
                if content_blocks_str:
                    try:
                        content_blocks = json.loads(content_blocks_str)
                    except (json.JSONDecodeError, TypeError):
                        pass

                r = CacheCheckResult(
                    hit=True,
                    response=parsed[0]["fields"].get("response"),
                    similarity=score,
                    confidence=confidence,
                    matched_key=matched_key,
                )
                if cost_saved is not None:
                    r.cost_saved = cost_saved
                if content_blocks is not None:
                    r.content_blocks = content_blocks
                results.append(r)

            # Single pipeline for all post-loop Valkey writes (TTL refreshes + cost stats).
            # Note: cost_saved_total Prometheus counter is incremented per-hit above (same
            # as check()), while the stats-hash hincrby is batched here. If the pipeline
            # fails, Prometheus and stats().cost_saved_micros may diverge by at most the
            # batch total — both paths are best-effort and this is an accepted trade-off.
            if keys_to_expire or total_cost_micros:
                try:
                    post_pipe = self._client.pipeline()
                    for expire_key in keys_to_expire:
                        post_pipe.expire(expire_key, self._default_ttl)
                    if total_cost_micros:
                        post_pipe.hincrby(self._stats_key, "cost_saved_micros", total_cost_micros)
                    await post_pipe.execute()
                except Exception:
                    pass  # best-effort

            return results

        return await self._traced("check_batch", _run)

    async def invalidate(self, filter: str) -> InvalidateResult:
        """Delete all entries matching a Valkey Search filter expression.

        Security note: ``filter`` is passed directly to FT.SEARCH. Only pass
        trusted, programmatically-constructed expressions — never unsanitised
        user input.
        """
        self._assert_initialized("invalidate")

        async def _run(span: Any) -> InvalidateResult:
            try:
                raw_result = await self._client.execute_command(
                    "FT.SEARCH", self._index_name, filter,
                    "RETURN", "0",
                    "LIMIT", "0", str(INVALIDATE_BATCH_SIZE),
                    "DIALECT", "2",
                )
            except Exception as err:
                raise ValkeyCommandError("FT.SEARCH", err)

            parsed = parse_ft_search_response(raw_result)
            if not parsed:
                _set_span_attrs(span, {"cache.name": self._name, "cache.filter": filter,
                                        "cache.deleted_count": 0, "cache.truncated": False})
                return InvalidateResult(deleted=0, truncated=False)

            keys = [r["key"] for r in parsed]
            truncated = len(keys) == INVALIDATE_BATCH_SIZE
            # Pipeline individual per-key DELs to avoid CROSSSLOT errors in
            # cluster mode (multi-key DEL triggers CROSSSLOT when keys span
            # multiple hash slots on the same node).
            try:
                pipe = self._client.pipeline()
                for key in keys:
                    pipe.delete(key)
                await pipe.execute()
            except Exception as err:
                raise ValkeyCommandError("DEL", err)

            _set_span_attrs(span, {"cache.name": self._name, "cache.filter": filter,
                                    "cache.deleted_count": len(keys), "cache.truncated": truncated})
            return InvalidateResult(deleted=len(keys), truncated=truncated)

        return await self._traced("invalidate", _run)

    async def invalidate_by_model(self, model: str) -> int:
        """Delete all entries tagged with the given model name."""
        total = 0
        while True:
            result = await self.invalidate(f"@model:{{{escape_tag(model)}}}")
            total += result.deleted
            if not result.truncated:
                break
            # Brief pause between iterations: Valkey Search indexes DELs
            # asynchronously, so FT.SEARCH can keep returning already-deleted
            # keys briefly. Without a pause the loop would busy-spin against Valkey.
            await asyncio.sleep(0.05)
        return total

    async def invalidate_by_category(self, category: str) -> int:
        """Delete all entries tagged with the given category."""
        total = 0
        while True:
            result = await self.invalidate(f"@category:{{{escape_tag(category)}}}")
            total += result.deleted
            if not result.truncated:
                break
            await asyncio.sleep(0.05)
        return total

    async def stats(self) -> CacheStats:
        self._assert_initialized("stats")
        raw = await self._client.hgetall(self._stats_key)
        raw = raw or {}

        def _int(key: str) -> int:
            val = raw.get(key)
            if val is None:
                val = raw.get(key.encode() if isinstance(key, str) else key.decode(), b"0")
            if isinstance(val, bytes):
                val = val.decode()
            try:
                return int(val)
            except (ValueError, TypeError):
                return 0

        hits = _int("hits")
        misses = _int("misses")
        total = _int("total")
        cost_saved_micros = _int("cost_saved_micros")
        hit_rate = hits / total if total > 0 else 0.0
        return CacheStats(hits=hits, misses=misses, total=total,
                          hit_rate=hit_rate, cost_saved_micros=cost_saved_micros)

    async def index_info(self) -> IndexInfo:
        self._assert_initialized("index_info")
        try:
            raw = await self._client.execute_command("FT.INFO", self._index_name)
        except Exception as err:
            raise ValkeyCommandError("FT.INFO", err)

        num_docs = 0
        indexing_state = "unknown"
        if isinstance(raw, (list, tuple)):
            i = 0
            while i < len(raw) - 1:
                key = raw[i]
                if isinstance(key, bytes):
                    key = key.decode()
                if key == "num_docs":
                    try:
                        num_docs = int(str(raw[i + 1]))
                    except (ValueError, TypeError):
                        pass
                elif key == "indexing":
                    val = raw[i + 1]
                    indexing_state = val.decode() if isinstance(val, bytes) else str(val)
                i += 2

        return IndexInfo(
            name=self._index_name,
            num_docs=num_docs,
            dimension=self._dimension,
            indexing_state=indexing_state,
        )

    async def threshold_effectiveness(
        self,
        *,
        category: str | None = None,
        min_samples: int = 100,
    ) -> ThresholdEffectivenessResult:
        self._assert_initialized("threshold_effectiveness")
        try:
            raw_entries = await self._client.zrange(self._similarity_window_key, 0, -1)
        except Exception:
            raw_entries = []
        all_entries = self._parse_window_entries(raw_entries)
        return self._compute_threshold_effectiveness(all_entries, category, min_samples)

    def _parse_window_entries(self, raw_entries: list) -> list[dict]:
        """Decode and validate raw ZRANGE results from the similarity window."""
        entries = []
        for raw in raw_entries or []:
            raw_str = raw.decode() if isinstance(raw, bytes) else str(raw)
            try:
                entry = json.loads(raw_str)
                if (isinstance(entry.get("score"), (int, float))
                        and entry.get("result") in ("hit", "miss")):
                    entries.append(entry)
            except (json.JSONDecodeError, TypeError):
                pass
        return entries

    def _compute_threshold_effectiveness(
        self,
        all_entries: list[dict],
        category: str | None,
        min_samples: int,
    ) -> ThresholdEffectivenessResult:
        threshold = self._category_thresholds.get(category or "", self._default_threshold) \
            if category else self._default_threshold

        entries = [
            e for e in all_entries
            if not category or e.get("category") == category
        ]

        sample_count = len(entries)
        category_label = category or "all"

        if sample_count < min_samples:
            return ThresholdEffectivenessResult(
                category=category_label,
                sample_count=sample_count,
                current_threshold=threshold,
                hit_rate=0.0,
                uncertain_hit_rate=0.0,
                near_miss_rate=0.0,
                avg_hit_similarity=0.0,
                avg_miss_similarity=0.0,
                recommendation="insufficient_data",
                reasoning=f"Only {sample_count} samples collected; {min_samples} required for a reliable recommendation.",
            )

        hits = [e for e in entries if e["result"] == "hit"]
        misses = [e for e in entries if e["result"] == "miss"]

        hit_rate = len(hits) / sample_count
        uncertain_hits = [e for e in hits if e["score"] >= threshold - self._uncertainty_band]
        uncertain_hit_rate = len(uncertain_hits) / len(hits) if hits else 0.0

        # Near-misses are scores just ABOVE the threshold (genuine close misses).
        # Scores below the threshold recorded as misses (rerank rejection, stale eviction)
        # must be excluded — they would produce negative avg_near_miss_delta, causing
        # recommended_threshold = threshold + negative_delta < threshold, contradicting
        # the "loosen" recommendation.
        near_misses = [e for e in misses if threshold < e["score"] <= threshold + 0.03]
        near_miss_rate = len(near_misses) / len(misses) if misses else 0.0

        avg_hit_similarity = sum(e["score"] for e in hits) / len(hits) if hits else 0.0
        avg_miss_similarity = sum(e["score"] for e in misses) / len(misses) if misses else 0.0
        avg_near_miss_delta = (
            sum(e["score"] - threshold for e in near_misses) / len(near_misses)
            if near_misses else 0.0
        )

        if uncertain_hit_rate > 0.2:
            recommendation = "tighten_threshold"
            recommended_threshold = max(0.0, threshold - self._uncertainty_band * 1.5)
            reasoning = (f"{uncertain_hit_rate * 100:.1f}% of hits are in the uncertainty band - "
                         "tighten the threshold to reduce false positives.")
        elif near_miss_rate > 0.3 and avg_near_miss_delta < 0.03:
            recommendation = "loosen_threshold"
            recommended_threshold = threshold + avg_near_miss_delta
            reasoning = (f"{near_miss_rate * 100:.1f}% of misses are very close to the threshold - "
                         "consider loosening to capture more hits.")
        else:
            recommendation = "optimal"
            recommended_threshold = None
            reasoning = (f"Hit rate is {hit_rate * 100:.1f}% with {uncertain_hit_rate * 100:.1f}% "
                         "uncertain hits - threshold appears well-calibrated.")

        return ThresholdEffectivenessResult(
            category=category_label,
            sample_count=sample_count,
            current_threshold=threshold,
            hit_rate=hit_rate,
            uncertain_hit_rate=uncertain_hit_rate,
            near_miss_rate=near_miss_rate,
            avg_hit_similarity=avg_hit_similarity,
            avg_miss_similarity=avg_miss_similarity,
            recommendation=recommendation,
            recommended_threshold=recommended_threshold,
            reasoning=reasoning,
        )

    async def threshold_effectiveness_all(
        self,
        *,
        min_samples: int = 100,
    ) -> list[ThresholdEffectivenessResult]:
        """Fetch the similarity window once, then compute per-category results in memory."""
        self._assert_initialized("threshold_effectiveness_all")

        try:
            raw_entries = await self._client.zrange(self._similarity_window_key, 0, -1)
        except Exception:
            raw_entries = []

        all_entries = self._parse_window_entries(raw_entries)
        categories = {e["category"] for e in all_entries if e.get("category")}

        return [
            self._compute_threshold_effectiveness(all_entries, None, min_samples),
            *[self._compute_threshold_effectiveness(all_entries, cat, min_samples)
              for cat in sorted(categories) if cat],
        ]

    # -- Private helpers --

    async def _search_entries(
        self, filter_expr: str, limit: int, offset: int = 0
    ) -> Any:
        """Execute a stable FT.SEARCH for use by adapters.

        Uses SORTBY inserted_at ASC so that offset-based pagination is reliable
        even across calls that delete entries from earlier pages.
        Always wraps exceptions in ValkeyCommandError so callers can use
        ``except ValkeyCommandError: raise`` to distinguish Valkey failures from
        empty results.
        """
        try:
            return await self._client.execute_command(
                "FT.SEARCH", self._index_name, filter_expr,
                "SORTBY", "inserted_at", "ASC",
                "LIMIT", str(offset), str(limit),
                "DIALECT", "2",
            )
        except ValkeyCommandError:
            raise
        except Exception as exc:
            raise ValkeyCommandError("FT.SEARCH", exc) from exc

    async def _do_initialize(self) -> None:
        with self._telemetry.tracer.start_as_current_span("semantic_cache.initialize") as span:
            try:
                dim, has_binary_refs = await self._ensure_index_and_get_dimension()
                self._dimension = dim
                self._has_binary_refs = has_binary_refs
                self._initialized = True
                span.set_status(StatusCode.OK)
                # Fire analytics init once — skip on flush()+initialize() re-runs
                if not self._analytics_initiated:
                    try:
                        loop = asyncio.get_running_loop()
                        t = loop.create_task(self._init_analytics_safe())
                        self._background_tasks.add(t)
                        t.add_done_callback(self._background_tasks.discard)
                    except RuntimeError:
                        pass
            except Exception as e:
                span.set_status(StatusCode.ERROR, str(e))
                raise

    async def _init_analytics_safe(self) -> None:
        if self._analytics_initiated:
            return
        self._analytics_initiated = True
        try:
            opts = self._analytics_opts
            analytics = await create_analytics(disabled=opts.disabled)
            if self._shutdown:
                await analytics.shutdown()
                return
            self._analytics = analytics
            await analytics.init(self._client, self._name, {
                "default_threshold": self._default_threshold,
                "uncertainty_band": self._uncertainty_band,
                "default_ttl": self._default_ttl,
                "has_cost_table": bool(self._cost_table),
                "uses_default_cost_table": self._uses_default_cost_table,
                "embedding_cache_enabled": self._embedding_cache_enabled,
                "category_threshold_count": len(self._category_thresholds),
                "dimension": self._dimension,
            })
            # Guard against flush() being called before this background task completed:
            # if _initialized is False here, the cache was flushed and we must not
            # start the stats loop (it would call stats() → _assert_initialized() → error).
            if (not self._shutdown and self._initialized
                    and opts.stats_interval_s > 0
                    and self._analytics is not NOOP_ANALYTICS):
                self._stats_task = asyncio.create_task(self._stats_loop(opts.stats_interval_s))
        except Exception:
            pass

    async def _stats_loop(self, interval_s: float) -> None:
        while not self._shutdown:
            try:
                await asyncio.sleep(interval_s)
                if self._shutdown:
                    break
                s = await self.stats()
                self._analytics.capture("stats_snapshot", {
                    "hits": s.hits,
                    "misses": s.misses,
                    "hit_rate": s.hit_rate,
                    "cost_saved_micros": s.cost_saved_micros,
                })
            except asyncio.CancelledError:
                break
            except Exception:
                pass

    async def _ensure_index_and_get_dimension(self) -> tuple[int, bool]:
        try:
            raw = await self._client.execute_command("FT.INFO", self._index_name)
            dim = self._parse_dimension_from_info(raw)
            has_binary_refs = self._parse_has_binary_refs_from_info(raw)
            if dim > 0:
                return dim, has_binary_refs
            probe_vector, _ = await self._embed("probe")
            return len(probe_vector), has_binary_refs
        except EmbeddingError:
            raise
        except Exception as err:
            if not self._is_index_not_found_error(err):
                raise ValkeyCommandError("FT.INFO", err)

        probe_vector, _ = await self._embed("probe")
        dim = len(probe_vector)
        try:
            await self._client.execute_command(
                "FT.CREATE", self._index_name, "ON", "HASH",
                "PREFIX", "1", self._entry_prefix,
                "SCHEMA",
                "prompt", "TEXT", "NOSTEM",
                "response", "TEXT", "NOSTEM",
                "model", "TAG",
                "category", "TAG",
                "binary_refs", "TAG",
                "inserted_at", "NUMERIC", "SORTABLE",
                "temperature", "NUMERIC",
                "top_p", "NUMERIC",
                "seed", "NUMERIC",
                "embedding", "VECTOR", "HNSW", "6",
                "TYPE", "FLOAT32", "DIM", str(dim), "DISTANCE_METRIC", "COSINE",
            )
        except Exception as err:
            raise ValkeyCommandError("FT.CREATE", err)
        return dim, True

    def _parse_has_binary_refs_from_info(self, info: Any) -> bool:
        if not isinstance(info, (list, tuple)):
            return False
        i = 0
        while i < len(info) - 1:
            key = info[i]
            if isinstance(key, bytes):
                key = key.decode()
            if key not in ("attributes", "fields"):
                i += 2
                continue
            attributes = info[i + 1]
            if not isinstance(attributes, (list, tuple)):
                i += 2
                continue
            for attr in attributes:
                if not isinstance(attr, (list, tuple)):
                    continue
                j = 0
                while j < len(attr) - 1:
                    ak = attr[j]
                    av = attr[j + 1]
                    if isinstance(ak, bytes):
                        ak = ak.decode()
                    if isinstance(av, bytes):
                        av = av.decode()
                    if str(ak) == "identifier" and str(av) == "binary_refs":
                        return True
                    j += 2
            i += 2
        return False

    def _parse_dimension_from_info(self, info: Any) -> int:
        if not isinstance(info, (list, tuple)):
            return 0
        i = 0
        while i < len(info) - 1:
            key = info[i]
            if isinstance(key, bytes):
                key = key.decode()
            if key not in ("attributes", "fields"):
                i += 2
                continue
            attributes = info[i + 1]
            if not isinstance(attributes, (list, tuple)):
                i += 2
                continue
            for attr in attributes:
                if not isinstance(attr, (list, tuple)):
                    continue
                is_vector = False
                dim = 0
                j = 0
                while j < len(attr) - 1:
                    ak = attr[j]
                    av = attr[j + 1]
                    if isinstance(ak, bytes):
                        ak = ak.decode()
                    ak = str(ak)
                    if isinstance(av, bytes):
                        av_str = av.decode()
                    else:
                        av_str = str(av)
                    if ak == "type" and av_str == "VECTOR":
                        is_vector = True
                    elif ak.lower() == "dim":
                        try:
                            dim = int(av_str)
                        except (ValueError, TypeError):
                            pass
                    elif ak == "index" and isinstance(av, (list, tuple)):
                        # Valkey Search 1.2 nests dimension inside 'index' sub-array
                        k = 0
                        while k < len(av) - 1:
                            ik = av[k]
                            iv = av[k + 1]
                            if isinstance(ik, bytes):
                                ik = ik.decode()
                            if str(ik) == "dimensions":
                                if isinstance(iv, bytes):
                                    iv = iv.decode()
                                try:
                                    d = int(str(iv))
                                    if d > 0:
                                        dim = d
                                except (ValueError, TypeError):
                                    pass
                            k += 2
                    j += 2
                if is_vector and dim > 0:
                    return dim
            i += 2
        return 0

    def _resolve_prompt(self, prompt: str | list[ContentBlock]) -> tuple[str, list[str]]:
        if isinstance(prompt, str):
            return prompt, []
        text = extract_text(prompt)  # type: ignore[arg-type]
        if not text:
            raise SemanticCacheUsageError(
                "Prompt contains no text blocks. Embedding providers require non-empty text. "
                "Ensure at least one TextBlock is present alongside any binary blocks."
            )
        binary_refs = extract_binary_refs(prompt)  # type: ignore[arg-type]
        return text, binary_refs

    async def _embed(self, text: str) -> tuple[list[float], float]:
        """Embed text with optional embedding cache. Returns (vector, duration_sec)."""
        # Compute once; reused for both cache GET and cache SET paths.
        embed_key = (
            f"{self._embed_key_prefix}{hashlib.sha256(text.encode()).hexdigest()}"
            if self._embedding_cache_enabled and text
            else None
        )

        if embed_key is not None:
            try:
                cached = await self._client.get(embed_key)
                if cached is not None and isinstance(cached, (bytes, bytearray)):
                    self._telemetry.metrics.embedding_cache_total.labels(
                        cache_name=self._name, result="hit"
                    ).inc()
                    return decode_float32(bytes(cached)), 0.0
            except Exception:
                pass
            self._telemetry.metrics.embedding_cache_total.labels(
                cache_name=self._name, result="miss"
            ).inc()

        start = time.perf_counter()
        try:
            vector = await self._embed_fn(text)
        except Exception as e:
            raise EmbeddingError(f"embed_fn failed: {e}", e)
        duration_sec = time.perf_counter() - start

        self._telemetry.metrics.embedding_duration.labels(
            cache_name=self._name
        ).observe(duration_sec)

        if embed_key is not None:
            try:
                await self._client.set(embed_key, encode_float32(vector), ex=self._embedding_cache_ttl)
            except Exception:
                pass

        return vector, duration_sec

    async def _traced(self, operation: str, fn: Any) -> Any:
        """Wrap fn(span) in an OTel span with automatic status and duration metric."""
        start = time.perf_counter()
        with self._telemetry.tracer.start_as_current_span(f"semantic_cache.{operation}") as span:
            try:
                result = await fn(span)
                span.set_status(StatusCode.OK)
                return result
            except Exception as e:
                span.set_status(StatusCode.ERROR, str(e))
                raise
            finally:
                self._telemetry.metrics.operation_duration.labels(
                    cache_name=self._name, operation=operation
                ).observe(time.perf_counter() - start)

    async def _record_stat(self, field: str) -> None:
        try:
            pipe = self._client.pipeline()
            pipe.hincrby(self._stats_key, "total", 1)
            pipe.hincrby(self._stats_key, field, 1)
            await pipe.execute()
        except Exception:
            pass  # best effort — never fail on stat writes

    async def _record_similarity_window(
        self, score: float, result: str, category: str
    ) -> None:
        now_ms = int(time.time() * 1000)
        # Include a unique nonce so identical (score, result, category) tuples are
        # each recorded as distinct ZADD members instead of overwriting each other.
        member = json.dumps({"score": score, "result": result, "category": category,
                             "_n": str(uuid.uuid4())})
        seven_days_ago = now_ms - 7 * 24 * 60 * 60 * 1000
        try:
            pipe = self._client.pipeline()
            pipe.zadd(self._similarity_window_key, {member: now_ms})
            pipe.zremrangebyscore(self._similarity_window_key, "-inf", seven_days_ago)
            pipe.zremrangebyrank(self._similarity_window_key, 0, -10001)
            await pipe.execute()
        except Exception:
            pass  # best effort — never fail on window writes

    def _assert_initialized(self, method: str) -> None:
        if not self._initialized:
            raise SemanticCacheUsageError(
                f"SemanticCache.initialize() must be called before {method}()."
            )

    def _assert_dimension(self, embedding: list[float]) -> None:
        if len(embedding) != self._dimension:
            raise SemanticCacheUsageError(
                f"Embedding dimension mismatch: index expects {self._dimension}, "
                f"embed_fn returned {len(embedding)}. Call flush() then initialize() to rebuild."
            )

    def _is_index_not_found_error(self, err: Exception) -> bool:
        msg = str(err).lower()
        return (
            "unknown index name" in msg
            or "no such index" in msg
            # Valkey Search 1.2: "index with name <n> not found in database 0"
            or ("index" in msg and "not found" in msg)
        )


def _safe_float(value: Any, default: float = float("nan")) -> float:
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _set_span_attrs(span: Any, attrs: dict[str, Any]) -> None:
    try:
        span.set_attributes(attrs)
    except Exception:
        pass
