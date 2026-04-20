import { describe, it, expect } from "vitest";
import { prepareParams } from "../../adapters/openai-responses";
import { composeNormalizer, hashBase64 } from "../../normalizer";

describe("prepareParams (OpenAI Responses)", () => {
  const normalizer = composeNormalizer({ base64: hashBase64 });

  it("instructions become a prepended system message", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      instructions: "You are helpful.",
      input: "Hi",
    });
    expect(prepared.messages[0].role).toBe("system");
    expect(prepared.messages[0].content).toBe("You are helpful.");
    expect(prepared.messages[1].role).toBe("user");
    expect(prepared.messages[1].content).toBe("Hi");
  });

  it("string input produces single user message", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      input: "Hello world",
    });
    expect(prepared.messages).toHaveLength(1);
    expect(prepared.messages[0]).toEqual({ role: "user", content: "Hello world" });
  });

  it("consecutive function_calls are grouped into one assistant message", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      input: [
        { type: "function_call", call_id: "c1", name: "alpha", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "beta", arguments: "{}" },
      ],
    });
    expect(prepared.messages).toHaveLength(1);
    expect(prepared.messages[0].role).toBe("assistant");
    const blocks = prepared.messages[0].content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe("c1");
    expect(blocks[1].id).toBe("c2");
  });

  it("function_call_output flushes assistant and creates tool message", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      input: [
        { type: "function_call", call_id: "c1", name: "weather", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "Sunny" },
      ],
    });
    expect(prepared.messages).toHaveLength(2);
    expect(prepared.messages[0].role).toBe("assistant");
    expect(prepared.messages[1].role).toBe("tool");
    expect((prepared.messages[1] as { toolCallId: string }).toolCallId).toBe("c1");
  });

  it("reasoning item with encrypted_content maps to ReasoningBlock", async () => {
    const prepared = await prepareParams({
      model: "o1",
      input: [{
        type: "reasoning",
        encrypted_content: "sig_xyz",
        summary: [{ type: "reasoning_text", text: "I think therefore I am." }],
      }],
    });
    expect(prepared.messages).toHaveLength(1);
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("reasoning");
    expect(block.text).toBe("I think therefore I am.");
    expect(block.opaqueSignature).toBe("sig_xyz");
  });

  it("input_image with file_id uses fileId source", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      input: [{
        role: "user",
        content: [{ type: "input_image", file_id: "file_abc123", detail: "high" }],
      }],
    });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("binary");
    expect(block.ref).toBe("fileid:openai:file_abc123");
    expect(block.detail).toBe("high");
  });

  it("malformed function_call arguments fall back to __raw", async () => {
    const prepared = await prepareParams({
      model: "gpt-4o",
      input: [{ type: "function_call", call_id: "c1", name: "fn", arguments: "BAD{{{" }],
    });
    const block = (prepared.messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.args).toEqual({ __raw: "BAD{{{" });
  });

  it("reasoning.effort maps to reasoningEffort", async () => {
    const prepared = await prepareParams({
      model: "o3",
      input: "Think hard.",
      reasoning: { effort: "high" },
    });
    expect(prepared.reasoningEffort).toBe("high");
  });
});
