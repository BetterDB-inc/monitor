import { Logger, Provider, Type } from '@nestjs/common';

/**
 * Injection tokens for the proprietary agent gateway + token service when they are
 * wired into the self-hosted WorkspaceAuthModule. They are provided only when the
 * proprietary `proprietary/agent` code is present in the build (it is in the
 * published images); otherwise consumers inject `null` (see @Optional usage).
 */
export const AGENT_TOKENS_SERVICE = 'AGENT_TOKENS_SERVICE';
export const AGENT_GATEWAY = 'AGENT_GATEWAY';

interface AgentGatewayModule {
  AgentGateway: Type<unknown>;
}

interface AgentTokensServiceModule {
  AgentTokensService: Type<unknown>;
}

/**
 * Builds the providers that make the proprietary AgentGateway + AgentTokensService
 * available in self-hosted mode, so a self-hosted instance can mint agent tokens and
 * accept outbound agent WebSocket connections (the same capability cloud gets via
 * AgentModule). Registering the concrete classes lets Nest instantiate them with DI
 * (AgentTokensService needs STORAGE_CLIENT; AgentGateway needs AgentTokensService +
 * the global ConnectionRegistry). Returns [] if the proprietary code is not built,
 * in which case the agent feature is simply unavailable.
 */
export function createAgentGatewayProviders(logger: Logger): Provider[] {
  try {
    // Relative to apps/api/src/auth/. tsconfig paths only apply at compile time, so
    // use the runtime-resolvable relative path (matches the pattern in main.ts).
    const { AgentGateway } = require('../../../../proprietary/agent/agent-gateway') as AgentGatewayModule;
    const { AgentTokensService } =
      require('../../../../proprietary/agent/agent-tokens.service') as AgentTokensServiceModule;
    return [
      AgentTokensService,
      AgentGateway,
      { provide: AGENT_TOKENS_SERVICE, useExisting: AgentTokensService },
      { provide: AGENT_GATEWAY, useExisting: AgentGateway },
    ];
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'module not found';
    logger.warn(`Agent gateway not available (self-hosted agent connections disabled): ${msg}`);
    return [];
  }
}
