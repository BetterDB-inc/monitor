import { join } from 'path';
import { Global, Logger, Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { resolveAuthSecret } from '../auth/auth-secret';
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

// AgentTokensService signs AND verifies agent-token JWTs with
// `process.env.SESSION_SECRET`. Self-hosted auth uses AUTH_SECRET (better-auth), so
// SESSION_SECRET is normally unset — and jsonwebtoken v9 throws on an empty secret
// ("secretOrPrivateKey must have a value"), which would make POST /agent-tokens
// (type:'agent') 500 instead of returning a token. Seed SESSION_SECRET from the same
// persisted secret better-auth resolves, so it is non-empty AND stable across
// restarts (a changing secret would invalidate every already-issued agent token).
// Cloud is unaffected: this module only loads outside cloud mode, where the
// deployment already sets SESSION_SECRET.
if (agentProviders.length > 0 && !process.env.SESSION_SECRET) {
  const dataDir = process.env.BETTERDB_DATA_DIR || join(process.cwd(), 'data');
  process.env.SESSION_SECRET = resolveAuthSecret(process.env, dataDir);
  logger.log('Seeded SESSION_SECRET for agent-token signing from the workspace auth secret');
}

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
