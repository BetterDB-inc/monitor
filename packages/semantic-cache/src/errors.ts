/**
 * Thrown when the caller does something wrong — e.g. calling check()
 * before initialize(), or providing an embedding with the wrong dimension.
 * The message is always actionable: it tells the caller what to fix.
 */
export class SemanticCacheUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SemanticCacheUsageError';
  }
}

/**
 * Thrown when the embedding function fails.
 * Check the underlying cause for the original error from the embedding provider.
 */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * Thrown when a Valkey command fails unexpectedly.
 * Includes the command name and the underlying error.
 */
export class ValkeyCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly cause: unknown,
  ) {
    super(
      `Valkey command '${command}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ValkeyCommandError';
  }
}

/**
 * Thrown by initialize() when the cache holds vectors from a different
 * embedding model than the one configured now.
 *
 * Vectors from two models occupy different spaces, so similarity scores
 * across them are meaningless. Resolve it by flushing the cache, by pointing
 * this process back at the original model, or by choosing a different
 * `onEmbeddingModelChange` policy.
 */
export class EmbeddingModelChangedError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Embedding model changed: the cache was populated with '${expected}' but this process ` +
        `embeds with '${actual}'. Vectors from different models are not comparable. Call ` +
        `flush() to discard the cache, revert to '${expected}', or set ` +
        `onEmbeddingModelChange to 'warn' or 'flush'.`,
    );
    this.name = 'EmbeddingModelChangedError';
  }
}
