/**
 * AWS Bedrock embedding helper for @betterdb/semantic-cache.
 *
 * Supports Titan Text Embeddings v2 (1024-dim) and Cohere Embed v3 (1024-dim).
 * Requires @aws-sdk/client-bedrock-runtime as a peer dependency.
 *
 * Usage:
 *   import { createBedrockEmbed } from '@betterdb/semantic-cache/embed/bedrock';
 *   const embed = createBedrockEmbed({ modelId: 'amazon.titan-embed-text-v2:0' });
 *   const cache = new SemanticCache({ client, embedFn: embed });
 */
import type { EmbedFn } from '../types';

export type BedrockEmbedModelId =
  | 'amazon.titan-embed-text-v2:0'
  | 'amazon.titan-embed-text-v1'
  | 'cohere.embed-english-v3'
  | 'cohere.embed-multilingual-v3'
  | (string & {});

export interface BedrockEmbedOptions {
  /**
   * Pre-configured BedrockRuntimeClient instance.
   * If not provided, a new client is created from environment credentials.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any;
  /**
   * Model ID to use for embeddings.
   * Default: 'amazon.titan-embed-text-v2:0'
   */
  modelId?: BedrockEmbedModelId;
  /** AWS region. Used only when client is not provided. Default: AWS_DEFAULT_REGION env var. */
  region?: string;
}

/**
 * Create an EmbedFn backed by the AWS Bedrock embedding models.
 * Requires @aws-sdk/client-bedrock-runtime to be installed.
 */
export function createBedrockEmbed(opts?: BedrockEmbedOptions): EmbedFn {
  const modelId = opts?.modelId ?? 'amazon.titan-embed-text-v2:0';
  let clientPromise: Promise<unknown> | null = null;
  let CommandClass: unknown = null;

  function getClient() {
    if (!clientPromise) {
      clientPromise = (async () => {
        if (opts?.client) {
          // Load InvokeModelCommand separately
          try {
            // @ts-ignore - optional peer dep
            const mod = await import('@aws-sdk/client-bedrock-runtime' as string);
            CommandClass = (mod as { InvokeModelCommand: unknown }).InvokeModelCommand;
          } catch {
            throw new Error(
              '@betterdb/semantic-cache embed/bedrock requires "@aws-sdk/client-bedrock-runtime". Install it.',
            );
          }
          return opts.client;
        }
        try {
          // @ts-ignore - optional peer dep
          const mod = await import('@aws-sdk/client-bedrock-runtime' as string);
          const { BedrockRuntimeClient, InvokeModelCommand } = mod as { BedrockRuntimeClient: new (cfg: unknown) => unknown; InvokeModelCommand: new (cmd: unknown) => unknown };
          CommandClass = InvokeModelCommand;
          return new BedrockRuntimeClient({
            region: opts?.region ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
          });
        } catch {
          throw new Error(
            '@betterdb/semantic-cache embed/bedrock requires "@aws-sdk/client-bedrock-runtime". Install it.',
          );
        }
      })();
    }
    return clientPromise;
  }

  return async (text: string): Promise<number[]> => {
    const client = await getClient();

    const isTitan = modelId.startsWith('amazon.titan');
    const isCohere = modelId.startsWith('cohere.embed');

    let body: Record<string, unknown>;
    if (isTitan) {
      body = { inputText: text };
    } else if (isCohere) {
      body = { texts: [text], input_type: 'search_document', truncate: 'END' };
    } else {
      body = { inputText: text };
    }

    const command = new (CommandClass as new (params: unknown) => unknown)({
      modelId,
      body: JSON.stringify(body),
      contentType: 'application/json',
      accept: 'application/json',
    });

    const response = await (client as { send: (cmd: unknown) => Promise<{ body: Uint8Array }> }).send(command);
    const decoded = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;

    if (isTitan) {
      return (parsed.embedding as number[]) ?? [];
    } else if (isCohere) {
      const embeddings = parsed.embeddings as number[][];
      return embeddings[0] ?? [];
    }

    // Generic fallback
    return (parsed.embedding as number[]) ?? (parsed.embeddings as number[][])?.[0] ?? [];
  };
}
