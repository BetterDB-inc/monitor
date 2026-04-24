# Changelog

## 0.1.0 — 2026-04-24

Initial release. Full Python port of `@betterdb/semantic-cache` v0.2.0.

### Features
- `SemanticCache` with check, store, store_multipart, check_batch, invalidate,
  stats, index_info, threshold_effectiveness, and flush
- Embedding cache (Float32 vectors stored in Valkey, bypasses embed_fn on repeated lookups)
- Cost tracking via bundled LiteLLM cost table (1,900+ models)
- Multi-modal prompts: `ContentBlock[]` with binary refs and AND-semantic TAG filtering
- Rerank hook, stale-model eviction, uncertainty band, per-category thresholds
- Rolling similarity window for threshold tuning recommendations
- Adapters: OpenAI Chat Completions, OpenAI Responses API, Anthropic Messages,
  LlamaIndex, LangChain (async-only BaseCache), LangGraph (BetterDBSemanticStore)
- Embedding helpers: OpenAI, Voyage AI, Cohere, Ollama, AWS Bedrock
- OTel tracing + 7 Prometheus metrics matching the TypeScript implementation exactly
- Cluster-aware SCAN for flush and invalidation
