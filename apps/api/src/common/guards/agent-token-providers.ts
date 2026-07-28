import { Logger, Provider, Type } from '@nestjs/common';
import { MCP_TOKEN_SERVICE } from './agent-token.guard';

interface AgentTokensModule {
  AgentTokensService: Type<unknown>;
}

export function createAgentTokenProviders(
  logger: Logger,
  loadModule: () => AgentTokensModule,
): Provider[] {
  if (process.env.CLOUD_MODE !== 'true') {
    return [];
  }
  try {
    const serviceClass = loadModule().AgentTokensService;
    return [serviceClass, { provide: MCP_TOKEN_SERVICE, useExisting: serviceClass }];
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'module not found';
    logger.warn(`Agent tokens service failed to load in cloud mode: ${msg}`);
    return [];
  }
}
