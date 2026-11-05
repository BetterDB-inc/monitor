---
name: betterdb-cache-miss
description: Use when the user asks why a semantic cache or agent cache is missing, about cache hit rate, a similarity threshold, an AI trace, or vector index health.
---

# Cache miss explainer

## Overview

Explain a miss from the cache's own stats. Propose a threshold change only when a similarity window supports it. A license sentence ends the cache steps, not a trace or vector question.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Call `cache_list` with `instanceId`.
   - A license sentence: cache tools are not available on this tier. Say that. Do not invent a threshold. If the user asked about a trace, go to step 7. If the user asked about vector search, go to step 8.
   - `No caches registered for this instance.`: say no cache is registered. Continue only if the user asked about traces or vector search.
3. For one named cache, call `cache_health`. Semantic caches return category breakdown and uncertain hit rate. Agent caches return a per-tool breakdown.
4. Call `cache_similarity_distribution` for a semantic cache, or `cache_tool_effectiveness` for an agent cache, before any proposal.
5. Call `cache_recent_changes` before proposing, so you do not repeat an open proposal.
6. Propose with `cache_propose_threshold_adjust` or `cache_propose_tool_ttl_adjust` only when the window supports the change. Proposals do not write to Valkey until `cache_approve_proposal`. Do not approve unless the user asked to apply it.
7. For a trace, call `list_ai_traces` even when `ai_list_instances` is empty. Set `hours` to the requested lookback, from 1 through 168. When the user gave no lookback, pass `hours` 1. `ai_list_instances` discovers AI components and has no time window. An empty list there does not mean there are no traces. An empty trace list means the `hours` window had none. Correlate with `get_ai_trace` and `correlate_ai_trace` using the id the user gave, or an id `list_ai_traces` returned. An id the user already has does not require either list.
8. For vector search, call `get_vector_indexes`. "Search module not loaded" is a clear stop. Call `get_inference_latency` only when indexes exist.

## Common mistakes

- Proposing a threshold on a community-tier license error.
- Correlating a trace id that the user did not supply and `list_ai_traces` did not return.
- Treating `get_vector_indexes` failure like the hot-key failure. The vector tool names the missing module.
