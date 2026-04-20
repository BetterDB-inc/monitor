/**
 * OpenAI Chat + @betterdb/agent-cache example
 *
 * Demonstrates multi-modal LLM caching with the OpenAI Chat Completions API:
 *   1. Text-only call - responses cached by prompt hash
 *   2. Vision call - image bytes content-addressed before hashing
 *   3. Tool call - tool call arguments round-tripped through cache
 *
 * Usage:
 *   docker run -d --name valkey -p 6379:6379 valkey/valkey:8
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx index.ts
 */
import Valkey, { Cluster } from "iovalkey";
import OpenAI from "openai";
import { AgentCache } from "@betterdb/agent-cache";
import { composeNormalizer, hashBase64 } from "@betterdb/agent-cache";
import { prepareParams } from "@betterdb/agent-cache/openai";
import type { ContentBlock, TextBlock, ToolCallBlock } from "@betterdb/agent-cache";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

// ── 1. Connect to Valkey (standalone or cluster) ─────────────────────
let valkey: Valkey;
if (process.env.VALKEY_CLUSTER) {
  const clusterNodes = (process.env.VALKEY_CLUSTER_NODES ?? "localhost:6401,localhost:6402,localhost:6403")
    .split(",").map(hp => {
      const [host, portStr] = hp.trim().split(":");
      const port = parseInt(portStr, 10);
      if (!host || isNaN(port)) throw new Error(`Invalid cluster node: "${hp}"`);
      return { host, port };
    });
  console.log(`Cluster mode — nodes: ${clusterNodes.map(n => `${n.host}:${n.port}`).join(", ")}`);
  valkey = new Cluster(clusterNodes) as unknown as Valkey;
} else {
  console.log("Standalone mode — localhost:6379");
  valkey = new Valkey({ host: "localhost", port: 6379 });
}

// ── 2. Create cache ──────────────────────────────────────────────────
const cache = new AgentCache({
  client: valkey,
  tierDefaults: { llm: { ttl: 3600 } },
  costTable: {
    "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
    "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  },
});

// ── 3. Create normalizer and OpenAI client ───────────────────────────
const normalizer = composeNormalizer({ base64: hashBase64 });
const client = new OpenAI();

// ── 4. Cached chat function ──────────────────────────────────────────
async function chat(params: ChatCompletionCreateParamsNonStreaming): Promise<string> {
  const cacheParams = await prepareParams(params, { normalizer });
  const cached = await cache.llm.check(cacheParams);

  if (cached.hit) {
    console.log("  [cache HIT]", cached.response?.slice(0, 60));
    return cached.response ?? "";
  }

  console.log("  [cache MISS] - calling OpenAI");
  const response = await client.chat.completions.create({ ...params, stream: false });
  const choice = response.choices[0];

  // Build content blocks from response
  const blocks: ContentBlock[] = [];
  if (choice.message.content) {
    blocks.push({ type: "text", text: choice.message.content } as TextBlock);
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let args: unknown;
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = { __raw: tc.function.arguments };
      }
      blocks.push({ type: "tool_call", id: tc.id, name: tc.function.name, args } as ToolCallBlock);
    }
  }

  await cache.llm.storeMultipart(cacheParams, blocks, {
    tokens: {
      input: response.usage?.prompt_tokens ?? 0,
      output: response.usage?.completion_tokens ?? 0,
    },
  });

  const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");
  return textBlocks.map(b => b.text).join("");
}

// ── 5. Run demo ──────────────────────────────────────────────────────
async function main() {
  console.log("\n=== 1. Text-only (run twice to see cache hit) ===");
  const text1 = await chat({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is 2+2? Answer in one word." }],
    max_tokens: 10,
  });
  console.log("  Response:", text1);
  const text2 = await chat({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is 2+2? Answer in one word." }],
    max_tokens: 10,
  });
  console.log("  Response:", text2);

  console.log("\n=== 2. Vision with data URL (image bytes content-addressed) ===");
  // 50x50 solid red PNG (generated with Node.js zlib - valid and OpenAI-accepted)
  const redPixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAIAAACRXR/mAAAAQ0lEQVR4nO3OMQ0AMAwDsPAnvRHonxyWDMB5yaD+QEtLS0tLa0N/oKWlpaWltaE/0NLS0tLS2tAfaGlpaWlpbegPTh97K7rEaOcNTQAAAABJRU5ErkJggg==";
  await chat({
    model: "gpt-4o-mini",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What color is this pixel? One word." },
        { type: "image_url", image_url: { url: redPixel, detail: "low" } },
      ],
    }],
    max_tokens: 10,
  });

  console.log("\n=== 3. Tool call (get_weather) ===");
  await chat({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is the weather in Paris?" }],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather for a city",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    }],
    tool_choice: "auto",
    max_tokens: 100,
  });

  const stats = await cache.stats();
  console.log("\n-- Cache Stats --");
  console.log(`LLM:        ${stats.llm.hits} hits / ${stats.llm.misses} misses (${(stats.llm.hitRate * 100).toFixed(0)}% hit rate)`);
  console.log(`Cost saved: $${(stats.costSavedMicros / 1_000_000).toFixed(6)}`);

  await cache.shutdown();
  await valkey.quit();
}

main().catch(console.error);
