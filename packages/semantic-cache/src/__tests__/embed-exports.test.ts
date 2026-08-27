import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createBedrockEmbed } from '../embed/bedrock';
import { createCohereEmbed } from '../embed/cohere';
import { createGoogleEmbed } from '../embed/google';
import { createOllamaEmbed } from '../embed/ollama';
import { createOpenAIEmbed } from '../embed/openai';
import { createVoyageEmbed } from '../embed/voyage';
import { embedderFingerprint, getEmbedderDescriptor } from '../embedder-identity';
import type { DescribedEmbedFn, EmbedderDescriptor } from '../types';

const packageRoot = resolve(__dirname, '../..');

function embedProviders(): string[] {
  return readdirSync(resolve(packageRoot, 'src/embed'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .filter((name) => name !== 'index' && name.startsWith('_') === false)
    .sort();
}

function packageExports(): Record<string, Record<string, string>> {
  const raw = readFileSync(resolve(packageRoot, 'package.json'), 'utf8');
  return JSON.parse(raw).exports;
}

describe('embed provider exports', () => {
  it('declares a subpath for every provider module', () => {
    const exportsMap = packageExports();
    const unreachable = embedProviders().filter((name) => {
      return Object.hasOwn(exportsMap, `./embed/${name}`) === false;
    });

    // An exports map is restrictive: a provider missing from it ships in the
    // tarball but cannot be imported. That shipped for embed/google.
    expect(unreachable).toEqual([]);
  });

  it('points each provider subpath at its own build output', () => {
    const exportsMap = packageExports();
    for (const name of embedProviders()) {
      expect(exportsMap[`./embed/${name}`]).toEqual({
        import: `./dist/embed/${name}.js`,
        require: `./dist/embed/${name}.js`,
        types: `./dist/embed/${name}.d.ts`,
      });
    }
  });
});

describe('embed provider identity', () => {
  const cases: Array<{
    name: string;
    create: () => DescribedEmbedFn;
    provider: string;
    model: string;
    fingerprint: string;
  }> = [
    {
      name: 'openai',
      create: () => {
        return createOpenAIEmbed();
      },
      provider: 'openai',
      model: 'text-embedding-3-small',
      fingerprint: 'openai:text-embedding-3-small',
    },
    {
      name: 'bedrock',
      create: () => {
        return createBedrockEmbed();
      },
      provider: 'bedrock',
      model: 'amazon.titan-embed-text-v2:0',
      fingerprint: 'bedrock:amazon.titan-embed-text-v2:0',
    },
    {
      name: 'ollama',
      create: () => {
        return createOllamaEmbed();
      },
      provider: 'ollama',
      model: 'nomic-embed-text',
      fingerprint: 'ollama:nomic-embed-text',
    },
    {
      name: 'voyage',
      create: () => {
        return createVoyageEmbed();
      },
      provider: 'voyage',
      model: 'voyage-3-lite',
      fingerprint: 'voyage:voyage-3-lite#inputType=query',
    },
    {
      name: 'cohere',
      create: () => {
        return createCohereEmbed();
      },
      provider: 'cohere',
      model: 'embed-english-v3.0',
      fingerprint: 'cohere:embed-english-v3.0#inputType=search_query',
    },
    {
      name: 'google',
      create: () => {
        return createGoogleEmbed();
      },
      provider: 'google',
      model: 'gemini-embedding-2',
      fingerprint: 'google:gemini-embedding-2#outputDimensionality=768&taskType=RETRIEVAL_QUERY',
    },
  ];

  it.each(cases)('describes the $name default embedder', (testCase) => {
    const descriptor = getEmbedderDescriptor(testCase.create());

    expect(descriptor).toBeDefined();
    expect(descriptor?.provider).toBe(testCase.provider);
    expect(descriptor?.model).toBe(testCase.model);
    expect(embedderFingerprint(descriptor as EmbedderDescriptor)).toBe(testCase.fingerprint);
  });

  it('reflects a non-default model in the fingerprint', () => {
    const embed = createOpenAIEmbed({ model: 'text-embedding-3-large' });

    expect(embedderFingerprint(getEmbedderDescriptor(embed) as EmbedderDescriptor)).toBe(
      'openai:text-embedding-3-large',
    );
  });

  it('reflects a non-default space-affecting param in the fingerprint', () => {
    const embed = createVoyageEmbed({ inputType: 'document' });

    expect(embedderFingerprint(getEmbedderDescriptor(embed) as EmbedderDescriptor)).toBe(
      'voyage:voyage-3-lite#inputType=document',
    );
  });

  it('omits outputDimensionality for a google model that has no default width', () => {
    const embed = createGoogleEmbed({ model: 'gemini-embedding-001' });

    expect(embedderFingerprint(getEmbedderDescriptor(embed) as EmbedderDescriptor)).toBe(
      'google:gemini-embedding-001#taskType=RETRIEVAL_QUERY',
    );
  });
});
