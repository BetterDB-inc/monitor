/**
 * Anthropic SDK + @betterdb/agent-cache example
 *
 * Demonstrates multi-modal LLM caching with the Anthropic Messages API:
 *   1. Text-only call - responses cached by prompt hash
 *   2. Vision call - image bytes content-addressed before hashing
 *   3. Tool call (get_weather) - tool calls cached through storeMultipart
 *
 * Usage:
 *   docker run -d --name valkey -p 6379:6379 valkey/valkey:8
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx index.ts
 */
import Valkey, { Cluster } from "iovalkey";
import Anthropic from "@anthropic-ai/sdk";
import { AgentCache } from "@betterdb/agent-cache";
import { composeNormalizer, hashBase64 } from "@betterdb/agent-cache";
import { prepareParams } from "@betterdb/agent-cache/anthropic";
import type { ContentBlock, TextBlock, ToolCallBlock, ReasoningBlock } from "@betterdb/agent-cache";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources";

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
    "claude-opus-4-5": { inputPer1k: 0.015, outputPer1k: 0.075 },
    "claude-haiku-4-5-20251001": { inputPer1k: 0.00025, outputPer1k: 0.00125 },
  },
});

// ── 3. Create normalizer and Anthropic client ────────────────────────
const normalizer = composeNormalizer({ base64: hashBase64 });
const client = new Anthropic();

// ── 4. Cached chat function ──────────────────────────────────────────
async function chat(params: MessageCreateParamsNonStreaming): Promise<string> {
  const cacheParams = await prepareParams(params, { normalizer });
  const cached = await cache.llm.check(cacheParams);

  if (cached.hit) {
    console.log("  [cache HIT]", cached.response?.slice(0, 60));
    return cached.response ?? "";
  }

  console.log("  [cache MISS] - calling Anthropic");
  const response = await client.messages.create(params);

  // Build content blocks from response
  const blocks: ContentBlock[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text } as TextBlock);
    } else if (block.type === "tool_use") {
      blocks.push({ type: "tool_call", id: block.id, name: block.name, args: block.input } as ToolCallBlock);
    } else if (block.type === "thinking") {
      blocks.push({ type: "reasoning", text: block.thinking, opaqueSignature: (block as { signature?: string }).signature } as ReasoningBlock);
    }
  }

  await cache.llm.storeMultipart(cacheParams, blocks, {
    tokens: {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
    },
  });

  const textBlocks = blocks.filter((b): b is TextBlock => b.type === "text");
  return textBlocks.map(b => b.text).join("");
}

// ── 5. Run demo ──────────────────────────────────────────────────────
async function main() {
  const model = "claude-haiku-4-5-20251001" as const;

  console.log("\n=== 1. Text-only (run twice to see cache hit) ===");
  const r1 = await chat({ model, max_tokens: 20, messages: [{ role: "user", content: "What is 2+2? One word." }] });
  console.log("  Response:", r1);
  const r2 = await chat({ model, max_tokens: 20, messages: [{ role: "user", content: "What is 2+2? One word." }] });
  console.log("  Response:", r2);

  console.log("\n=== 2. Vision with base64 image ===");
  // 50x50 solid red PNG (generated with Node.js zlib - valid and accepted by APIs)
  const redPixel = "iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAIAAACRXR/mAAAAQ0lEQVR4nO3OMQ0AMAwDsPAnvRHonxyWDMB5yaD+QEtLS0tLa0N/oKWlpaWltaE/0NLS0tLS2tAfaGlpaWlpbegPTh97K7rEaOcNTQAAAABJRU5ErkJggg==";
  await chat({
    model,
    max_tokens: 20,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What color is this pixel? One word." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: redPixel } },
      ],
    }],
  });

  console.log("\n=== 3. Tool call (get_weather) ===");
  await chat({
    model,
    max_tokens: 100,
    tools: [{
      name: "get_weather",
      description: "Get current weather for a city",
      input_schema: {
        type: "object" as const,
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    }],
    messages: [{ role: "user", content: "What is the weather in Paris?" }],
  });

  const stats = await cache.stats();
  console.log("\n-- Cache Stats --");
  console.log(`LLM:        ${stats.llm.hits} hits / ${stats.llm.misses} misses (${(stats.llm.hitRate * 100).toFixed(0)}% hit rate)`);
  console.log(`Cost saved: $${(stats.costSavedMicros / 1_000_000).toFixed(6)}`);

  await cache.shutdown();
  await valkey.quit();
}

main().catch(console.error);
