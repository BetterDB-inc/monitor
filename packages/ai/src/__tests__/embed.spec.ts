import { describe, expect, it } from 'vitest';

describe('@betterdb/ai embed subpaths', () => {
  it.each([
    ['openai', 'createOpenAIEmbed'],
    ['bedrock', 'createBedrockEmbed'],
    ['voyage', 'createVoyageEmbed'],
    ['cohere', 'createCohereEmbed'],
    ['ollama', 'createOllamaEmbed'],
    ['google', 'createGoogleEmbed'],
  ])('exposes %s as %s', async (name, factory) => {
    const m = await import(`../embed/${name}`);
    expect(typeof m[factory]).toBe('function');
  });
});
