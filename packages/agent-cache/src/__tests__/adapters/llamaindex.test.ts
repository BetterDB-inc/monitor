import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { prepareParams } from "../../adapters/llamaindex";
import { composeNormalizer, hashBase64 } from "../../normalizer";
import { llmCacheHash } from "../../utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "../fixtures/cross-provider");

describe("prepareParams (LlamaIndex)", () => {
  const normalizer = composeNormalizer({ base64: hashBase64 });

  it("normalizes cross-provider fixture to expected-params.json", async () => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, "llamaindex.json"), "utf8"));
    const expected = JSON.parse(readFileSync(join(fixturesDir, "expected-params.json"), "utf8"));
    const prepared = await prepareParams(raw.messages, {
      model: raw.model,
      maxTokens: raw.max_tokens,
      normalizer,
    });
    expect(prepared).toEqual(expected);
  });

  it("llmCacheHash produces stable value for fixture", async () => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, "llamaindex.json"), "utf8"));
    const prepared = await prepareParams(raw.messages, {
      model: raw.model,
      maxTokens: raw.max_tokens,
      normalizer,
    });
    expect(llmCacheHash(prepared)).toMatchSnapshot();
  });

  it("toolCall option builds ToolCallBlock on assistant message", async () => {
    const prepared = await prepareParams([{
      role: "assistant",
      content: "",
      options: { toolCall: [{ id: "c1", name: "search", input: { q: "test" } }] },
    }], { model: "gpt-4o" });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("tool_call");
    expect(block.id).toBe("c1");
    expect(block.args).toEqual({ q: "test" });
  });

  it("toolResult option produces tool-role message regardless of message role", async () => {
    const prepared = await prepareParams([{
      role: "assistant",
      content: "",
      options: { toolResult: { id: "c1", result: "42", isError: false } },
    }], { model: "gpt-4o" });
    expect(prepared.messages[0].role).toBe("tool");
    expect((prepared.messages[0] as { toolCallId: string }).toolCallId).toBe("c1");
  });

  it("memory role maps to system", async () => {
    const prepared = await prepareParams([{
      role: "memory",
      content: "Remember: user prefers metric units.",
    }], { model: "gpt-4o" });
    expect(prepared.messages[0].role).toBe("system");
  });

  it("image_url data URL is content-addressed", async () => {
    const sha256Hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const prepared = await prepareParams([{
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: "data:image/png;base64,aGVsbG8=" },
      }],
    }], { model: "gpt-4o", normalizer });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("binary");
    expect(block.ref).toBe("sha256:" + sha256Hello);
  });
});
