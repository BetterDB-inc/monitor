import { HttpException } from '@nestjs/common';
import { AGENT_READ_ONLY_MESSAGE } from '@betterdb/shared';

/**
 * Thrown by an agent-backed connection when a state-changing command is
 * refused because the agent asked for read-only. A typed error so every
 * caller (HTTP, CLI, MCP) can tell it from a server failure without matching
 * on the message; AgentReadOnlyFilter turns it into a 403 for HTTP.
 */
export class AgentReadOnlyError extends Error {
  readonly name = 'AgentReadOnlyError';

  constructor() {
    super(AGENT_READ_ONLY_MESSAGE);
  }
}

/**
 * True for the error itself and for an HttpException a controller wrapped it
 * in (`new HttpException(message, status, { cause })`), so the filter can
 * still answer 403 behind the controllers' catch blocks.
 */
export function isAgentReadOnlyError(error: unknown): boolean {
  if (error instanceof AgentReadOnlyError) return true;
  return error instanceof HttpException && isAgentReadOnlyError(error.cause);
}
