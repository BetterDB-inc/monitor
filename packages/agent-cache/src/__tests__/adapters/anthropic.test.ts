import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { prepareParams } from "../../adapters/anthropic";
import { composeNormalizer, hashBase64, passthrough } from "../../normalizer";
import { llmCacheHash } from "../../utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "../fixtures/cross-provider");

describe("prepareParams (Anthropic)", () => {
  const normalizer = composeNormalizer({ base64: hashBase64 });

  it("normalizes cross-provider fixture to expected-params.json", async () => {
    const input = JSON.parse(readFileSync(join(fixturesDir, "anthropic.json"), "utf8"));
    const expected = JSON.parse(readFileSync(join(fixturesDir, "expected-params.json"), "utf8"));
    const prepared = await prepareParams(input, { normalizer });
    expect(prepared).toEqual(expected);
  });

  it("llmCacheHash produces stable value for fixture", async () => {
    const input = JSON.parse(readFileSync(join(fixturesDir, "anthropic.json"), "utf8"));
    const prepared = await prepareParams(input, { normalizer });
    expect(llmCacheHash(prepared)).toMatchSnapshot();
  });

  it("tool_result blocks are split into separate tool messages", async () => {
    const prepared = await prepareParams({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Result A" },
          { type: "tool_result", tool_use_id: "t2", content: "Result B" },
          { type: "text", text: "What next?" },
        ],
      }],
    });
    expect(prepared.messages).toHaveLength(3);
    expect(prepared.messages[0].role).toBe("tool");
    expect((prepared.messages[0] as { toolCallId: string }).toolCallId).toBe("t1");
    expect(prepared.messages[1].role).toBe("tool");
    expect((prepared.messages[1] as { toolCallId: string }).toolCallId).toBe("t2");
    expect(prepared.messages[2].role).toBe("user");
  });

  it("thinking block maps to ReasoningBlock", async () => {
    const prepared = await prepareParams({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{
        role: "assistant",
        content: [{
          type: "thinking",
          thinking: "Let me reason...",
          signature: "sig_abc",
        }],
      }],
    });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("reasoning");
    expect(block.text).toBe("Let me reason...");
    expect(block.opaqueSignature).toBe("sig_abc");
  });

  it("redacted_thinking block maps to ReasoningBlock with redacted flag", async () => {
    const prepared = await prepareParams({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{
        role: "assistant",
        content: [{ type: "redacted_thinking", data: "encrypted_data" }],
      }],
    });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("reasoning");
    expect(block.redacted).toBe(true);
    expect(block.opaqueSignature).toBe("encrypted_data");
    expect(block.text).toBe("");
  });

  it("cache_control on text block preserved in hints", async () => {
    const prepared = await prepareParams({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Hello",
          cache_control: { type: "ephemeral" },
        }],
      }],
    });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.hints).toEqual({ anthropicCacheControl: { type: "ephemeral" } });
  });

  it("base64 image is content-addressed by normalizer", async () => {
    const sha256Hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const prepared = await prepareParams({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        }],
      }],
    }, { normalizer });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("binary");
    expect(block.ref).toBe("sha256:" + sha256Hello);
    expect(block.mediaType).toBe("image/png");
  });

  it("URL image uses url: prefix with passthrough normalizer", async () => {
    const passthroughNorm = composeNormalizer();
    const prepared = await prepareParams({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [{
          type: "image",
          source: { type: "url", url: "https://example.com/cat.png" },
        }],
      }],
    }, { normalizer: passthroughNorm });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("binary");
    expect((block.ref as string).startsWith("url:")).toBe(true);
  });
});
