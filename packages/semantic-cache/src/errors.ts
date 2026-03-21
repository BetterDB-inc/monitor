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
