import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { prepareParams as prepareOpenAI } from "../../adapters/openai-chat";
import { prepareParams as prepareAnthropic } from "../../adapters/anthropic";
import { prepareParams as prepareLlamaIndex } from "../../adapters/llamaindex";
import { composeNormalizer, hashBase64 } from "../../normalizer";
import { llmCacheHash } from "../../utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "../fixtures/cross-provider");

describe("cross-provider IR equality", () => {
  const normalizer = composeNormalizer({ base64: hashBase64 });

  async function getAll() {
    const oaiIn = JSON.parse(readFileSync(join(fixturesDir, "openai-chat.json"), "utf8"));
    const anthIn = JSON.parse(readFileSync(join(fixturesDir, "anthropic.json"), "utf8"));
    const llmIn = JSON.parse(readFileSync(join(fixturesDir, "llamaindex.json"), "utf8"));
    const expected = JSON.parse(readFileSync(join(fixturesDir, "expected-params.json"), "utf8"));

    const oai = await prepareOpenAI(oaiIn, { normalizer });
    const anth = await prepareAnthropic(anthIn, { normalizer });
    const llm = await prepareLlamaIndex(llmIn.messages, {
      model: llmIn.model,
      maxTokens: llmIn.max_tokens,
      normalizer,
    });

    return { oai, anth, llm, expected };
  }

  it("all three adapters produce params matching expected-params.json", async () => {
    const { oai, anth, llm, expected } = await getAll();
    expect(oai).toEqual(expected);
    expect(anth).toEqual(expected);
    expect(llm).toEqual(expected);
  });

  it("all three adapters produce identical hashes", async () => {
    const { oai, anth, llm } = await getAll();
    const hOai = llmCacheHash(oai);
    const hAnth = llmCacheHash(anth);
    const hLlm = llmCacheHash(llm);
    expect(hOai).toBe(hAnth);
    expect(hOai).toBe(hLlm);
  });
});
