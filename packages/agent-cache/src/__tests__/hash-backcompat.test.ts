import { describe, it, expect } from "vitest";
import { llmCacheHash } from "../utils";

describe("llmCacheHash v0.2.0 backward compatibility", () => {
  it("simple_text fixture produces stable hash", () => {
    const params = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    };
    expect(llmCacheHash(params)).toBe("029b2f180b42427a44aa63db387e7b421c8454ae987a6a41d3099363a67f67c5");
  });

  it("text_with_tools fixture produces stable hash", () => {
    const params = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "What is 2+2?" },
      ],
      temperature: 0.7,
      tools: [{
        type: "function" as const,
        function: { name: "calculate", description: "Math helper" },
      }],
    };
    expect(llmCacheHash(params)).toBe("9f167df3b1adb0eb307de6d5b47a6fe3dea66360bc4c1bb8d28152388ec5c526");
  });

  it("adding content-block array for same text produces different hash", () => {
    const textOnly = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    };
    const blocks = {
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: [{ type: "text" as const, text: "Hello" }],
      }],
    };
    expect(llmCacheHash(textOnly)).not.toBe(llmCacheHash(blocks));
  });
});
