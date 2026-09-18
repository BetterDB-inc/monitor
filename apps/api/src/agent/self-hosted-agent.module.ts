import { Global, Logger, Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import {
  AGENT_GATEWAY,
  AGENT_TOKENS_SERVICE,
  createAgentGatewayProviders,
} from '../auth/agent-gateway.providers';

const logger = new Logger('SelfHostedAgentModule');

// Providers for the proprietary AgentGateway + AgentTokensService. Empty when the
// proprietary agent code is not built, in which case the agent feature is simply
// unavailable and consumers (PersonalTokensController) inject null via @Optional.
const agentProviders = createAgentGatewayProviders(logger);

/**
 * Wires BetterDB agent connections for SELF-HOSTED deployments — the same capability
 * the cloud gets from the proprietary AgentModule, but decoupled from workspace auth.
 *
 * It is @Global so the AGENT_TOKENS_SERVICE / AGENT_GATEWAY tokens are injectable
 * from PersonalTokensController (which lives in WorkspaceAuthModule) without coupling
 * the two modules. AgentGateway depends on the globally-provided ConnectionRegistry
 * (from ConnectionsModule), mirroring how the cloud AgentModule resolves it.
 *
 * app.module.ts loads this only when NOT in cloud mode, so it never double-provides
 * AgentGateway alongside the cloud AgentModule.
 */
@Global()
@Module({
  imports: [StorageModule],
  providers: agentProviders,
  exports: agentProviders.length > 0 ? [AGENT_TOKENS_SERVICE, AGENT_GATEWAY] : [],
})
export class SelfHostedAgentModule {}
