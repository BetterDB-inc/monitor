import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { prepareParams } from "../../adapters/openai-chat";
import { composeNormalizer, hashBase64 } from "../../normalizer";
import { llmCacheHash } from "../../utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "../fixtures/cross-provider");

describe("prepareParams (OpenAI Chat)", () => {
  const normalizer = composeNormalizer({ base64: hashBase64 });

  it("normalizes cross-provider fixture to expected params", async () => {
    const input = JSON.parse(readFileSync(join(fixturesDir, "openai-chat.json"), "utf8"));
    const expected = JSON.parse(readFileSync(join(fixturesDir, "expected-params.json"), "utf8"));
    const prepared = await prepareParams(input, { normalizer });
    expect(prepared).toEqual(expected);
  });

  it("llmCacheHash produces stable value for fixture", async () => {
    const input = JSON.parse(readFileSync(join(fixturesDir, "openai-chat.json"), "utf8"));
    const prepared = await prepareParams(input, { normalizer });
    expect(llmCacheHash(prepared)).toMatchSnapshot();
  });

  it("parallel tool calls preserve order", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "alpha", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "beta", arguments: "{}" } },
          { id: "c3", type: "function", function: { name: "gamma", arguments: "{}" } },
        ],
      }],
    });
    const blocks = prepared.messages[0].content as Array<{ id: string }>;
    expect(blocks[0].id).toBe("c1");
    expect(blocks[1].id).toBe("c2");
    expect(blocks[2].id).toBe("c3");
  });

  it("malformed tool call arguments fall back to __raw", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      messages: [{
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "c1",
          type: "function",
          function: { name: "test", arguments: "not valid json{{{" },
        }],
      }],
    });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("tool_call");
    expect(block.args).toEqual({ __raw: "not valid json{{{" });
  });

  it("plain string user content is wrapped in a text block array (cross-provider parity)", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is 2+2?" }],
    });
    expect(Array.isArray(prepared.messages[0].content)).toBe(true);
    expect(prepared.messages[0].content).toEqual([{ type: "text", text: "What is 2+2?" }]);
  });

  it("image_url detail field is preserved in binary block", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "https://example.com/img.png", detail: "high" },
        }],
      }],
    }, { normalizer });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("binary");
    expect(block.detail).toBe("high");
  });
});
