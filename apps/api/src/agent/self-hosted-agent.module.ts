import { join } from 'path';
import { Global, Logger, Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { resolveAuthSecretWithSource } from '../auth/auth-secret';
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
//
// A configured SESSION_SECRET is only kept if it is actually strong: a truthiness
// check alone would accept a whitespace-only or too-short value and hand it to HS256
// signing. Treat anything shorter than 32 non-whitespace characters as unset and
// fall back to the resolved auth secret. Cloud is unaffected: this module only loads
// outside cloud mode.
const MIN_SESSION_SECRET_LENGTH = 32;
if (agentProviders.length > 0) {
  const configured = (process.env.SESSION_SECRET ?? '').trim();
  if (configured.length < MIN_SESSION_SECRET_LENGTH) {
    if (configured.length > 0) {
      logger.warn(
        `SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters; ignoring it and ` +
          'using the workspace auth secret for agent-token signing instead.',
      );
    }
    const dataDir = process.env.BETTERDB_DATA_DIR || join(process.cwd(), 'data');
    const resolved = resolveAuthSecretWithSource(process.env, dataDir);
    process.env.SESSION_SECRET = resolved.secret;
    if (resolved.ephemeral) {
      // resolveAuthSecret fell back to a per-process random value (no AUTH_SECRET and
      // the data dir could not be read/written). Agent tokens are signed for 365d, so
      // an ephemeral secret means every issued token STOPS validating after a restart
      // and each agent must be re-provisioned by hand. Surface it at boot.
      logger.warn(
        'Agent-token signing is using an EPHEMERAL secret: it is regenerated on every restart, ' +
          'so already-issued agent tokens will stop working after a restart. Set AUTH_SECRET ' +
          '(>=32 chars) or make BETTERDB_DATA_DIR writable to persist it.',
      );
    } else {
      logger.log('Seeded SESSION_SECRET for agent-token signing from the workspace auth secret');
    }
  }
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
