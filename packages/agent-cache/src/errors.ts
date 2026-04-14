export class AgentCacheError extends Error {
  constructor(message: string) {
    super(message);
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
  public readonly cause: unknown;
  constructor(command: string, cause: unknown) {
    super(`Valkey command failed: ${command} - ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ValkeyCommandError';
    this.cause = cause;
  }
}
