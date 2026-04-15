export class AgentCacheError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentCacheError';
  }
}

export class AgentCacheUsageError extends AgentCacheError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCacheUsageError';
  }
}

export class ValkeyCommandError extends AgentCacheError {
  constructor(command: string, cause: unknown) {
    super(
      `Valkey command failed: ${command} - ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
    this.name = 'ValkeyCommandError';
  }
}
