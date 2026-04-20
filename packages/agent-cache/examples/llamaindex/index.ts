/**
 * LlamaIndex TS + @betterdb/agent-cache example
 *
 * Demonstrates LLM caching with the LlamaIndex OpenAI adapter:
 *   1. Text-only call - responses cached by prompt hash
 *   2. Vision call - image bytes content-addressed before hashing
 *
 * Usage:
 *   docker run -d --name valkey -p 6379:6379 valkey/valkey:8
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx index.ts
 */
import Valkey from "iovalkey";
import { OpenAI } from "@llamaindex/openai";
import { AgentCache } from "@betterdb/agent-cache";
import { composeNormalizer, hashBase64 } from "@betterdb/agent-cache";
import { prepareParams } from "@betterdb/agent-cache/llamaindex";
import type { ContentBlock, TextBlock } from "@betterdb/agent-cache";
import type { ChatMessage } from "@llamaindex/core/llms";

// ── 1. Connect to Valkey ─────────────────────────────────────────────
const valkey = new Valkey({ host: "localhost", port: 6379 });

// ── 2. Create cache ──────────────────────────────────────────────────
const cache = new AgentCache({
  client: valkey,
  tierDefaults: { llm: { ttl: 3600 } },
  costTable: {
    "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  },
});

// ── 3. Create normalizer and LlamaIndex client ───────────────────────
const normalizer = composeNormalizer({ base64: hashBase64 });
const llm = new OpenAI({ model: "gpt-4o-mini" });

// ── 4. Cached chat function ──────────────────────────────────────────
async function chat(messages: ChatMessage[]): Promise<string> {
  const cacheParams = await prepareParams(messages, {
    model: "gpt-4o-mini",
    normalizer,
  });
  const cached = await cache.llm.check(cacheParams);

  if (cached.hit) {
    console.log("  [cache HIT]", cached.response?.slice(0, 60));
    return cached.response ?? "";
  }

  console.log("  [cache MISS] - calling LlamaIndex/OpenAI");
  const response = await llm.chat({ messages });

  const text = response.message.content as string;
  const blocks: ContentBlock[] = [{ type: "text", text } as TextBlock];

  await cache.llm.storeMultipart(cacheParams, blocks);

  return text;
}

// ── 5. Run demo ──────────────────────────────────────────────────────
async function main() {
  console.log("\n=== 1. Text-only (run twice to see cache hit) ===");
  const r1 = await chat([{ role: "user", content: "What is the capital of France? One word." }]);
  console.log("  Response:", r1);
  const r2 = await chat([{ role: "user", content: "What is the capital of France? One word." }]);
  console.log("  Response:", r2);

  console.log("\n=== 2. Vision with data URL ===");
  // 1x1 red PNG as data URL
  const redPixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";
  await chat([{
    role: "user",
    content: [
      { type: "text", text: "What color is this pixel? One word." },
      { type: "image_url", image_url: { url: redPixel } },
    ],
  }]);

  const stats = await cache.stats();
  console.log("\n-- Cache Stats --");
  console.log(`LLM: ${stats.llm.hits} hits / ${stats.llm.misses} misses`);

  await cache.shutdown();
  await valkey.quit();
}

main().catch(console.error);
