/**
 * Google AI (Gemini) embedding helper for @betterdb/semantic-cache.
 *
 * Supports gemini-embedding-2 and other Gemini embedding models via the
 * Google AI REST API. Uses native fetch - no SDK required.
 *
 * Usage:
 *   import { createGoogleEmbed } from '@betterdb/semantic-cache/embed/google';
 *   const embed = createGoogleEmbed({ model: 'gemini-embedding-2' });
 *   const cache = new SemanticCache({ client, embedFn: embed });
 */
import type { DescribedEmbedFn } from '../types';
import { describeEmbedder } from '../embedder-identity';

export type GoogleEmbedTaskType =
  | 'RETRIEVAL_QUERY'
  | 'RETRIEVAL_DOCUMENT'
  | 'SEMANTIC_SIMILARITY'
  | 'CLASSIFICATION'
  | 'CLUSTERING'
  | 'QUESTION_ANSWERING'
  | 'FACT_VERIFICATION'
  | 'CODE_RETRIEVAL_QUERY'
  | (string & {});

const TASK_INSTRUCTIONS: Record<string, string> = {
  RETRIEVAL_QUERY: 'search result',
  QUESTION_ANSWERING: 'question answering',
  FACT_VERIFICATION: 'fact checking',
  CODE_RETRIEVAL_QUERY: 'code retrieval',
  CLASSIFICATION: 'classification',
  CLUSTERING: 'clustering',
  SEMANTIC_SIMILARITY: 'sentence similarity',
};

/**
 * gemini-embedding-2 rejects the taskType field and expects the task to be
 * carried by the input text instead. Documents use `title: … | text: …`;
 * every other task uses `task: … | query: …`. Text is passed through
 * unchanged when the task has no documented instruction.
 */
function applyTaskInstruction(text: string, taskType: string, title?: string): string {
  if (taskType === 'RETRIEVAL_DOCUMENT') {
    return `title: ${title ?? 'none'} | text: ${text}`;
  }
  if (!Object.hasOwn(TASK_INSTRUCTIONS, taskType)) {
    return text;
  }
  return `task: ${TASK_INSTRUCTIONS[taskType]} | query: ${text}`;
}

export interface GoogleEmbedOptions {
  /**
   * Google AI embedding model.
   * Default: 'gemini-embedding-2'.
   * Other options: 'gemini-embedding-001'.
   *
   * Note: 'text-embedding-004' and 'embedding-001' were shut down by Google on
   * 2026-01-14 and 2025-10-30 respectively and no longer resolve.
   */
  model?: string;
  /** Google AI (Gemini) API key. Default: GOOGLE_API_KEY env var. */
  apiKey?: string;
  /** API base URL. Default: 'https://generativelanguage.googleapis.com/v1beta'. */
  baseUrl?: string;
  /**
   * Task type hint for the embedding.
   * Default: 'RETRIEVAL_QUERY'. Use 'RETRIEVAL_DOCUMENT' when storing.
   *
   * Note: gemini-embedding-2 does not accept a taskType field. For that model
   * the task is expressed as a prefix on the input text instead, so the same
   * option keeps working and the request shape differs.
   */
  taskType?: GoogleEmbedTaskType;
  /**
   * Optional document title, used only with taskType 'RETRIEVAL_DOCUMENT'.
   * Improves retrieval quality when provided alongside the document body.
   */
  title?: string;
  /**
   * Output dimensionality (Matryoshka truncation).
   *
   * Defaults to 768 for gemini-embedding-2 only, matching the dimensionality
   * this provider has always produced so an existing vector index stays
   * compatible; pass 3072 for that model's full width. For any other model the
   * field is omitted unless set, leaving the model's own default intact.
   *
   * Note: gemini-embedding-2 re-normalizes truncated dimensions itself, but
   * gemini-embedding-001 does not — normalize its output before cosine
   * similarity when requesting anything other than 3072.
   */
  outputDimensionality?: number;
}

/**
 * Create an EmbedFn backed by the Google AI (Gemini) Embeddings API.
 * Uses native fetch - no SDK required.
 */
export function createGoogleEmbed(opts?: GoogleEmbedOptions): DescribedEmbedFn {
  const model = opts?.model ?? 'gemini-embedding-2';
  const baseUrl = opts?.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const taskType = opts?.taskType ?? 'RETRIEVAL_QUERY';
  const isGeminiEmbedding2 = model === 'gemini-embedding-2';
  const outputDimensionality = opts?.outputDimensionality ?? (isGeminiEmbedding2 ? 768 : undefined);

  const embed = async (text: string): Promise<number[]> => {
    const apiKey = opts?.apiKey ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Google API key is required. Set GOOGLE_API_KEY env var or pass apiKey in options.',
      );
    }

    const content = isGeminiEmbedding2 ? applyTaskInstruction(text, taskType, opts?.title) : text;
    const requestBody: Record<string, unknown> = {
      model: `models/${model}`,
      content: { parts: [{ text: content }] },
    };

    if (outputDimensionality !== undefined) {
      requestBody.outputDimensionality = outputDimensionality;
    }

    if (!isGeminiEmbedding2) {
      requestBody.taskType = taskType;
      if (opts?.title !== undefined) {
        requestBody.title = opts.title;
      }
    }

    const res = await fetch(`${baseUrl}/models/${model}:embedContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google AI API error: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { embedding: { values: number[] } };
    return json.embedding?.values ?? [];
  };

  return describeEmbedder(embed, {
    provider: 'google',
    model,
    params: { taskType, outputDimensionality },
  });
}
