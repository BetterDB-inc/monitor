import { Global, Logger, Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { ConnectionsModule } from '@app/connections/connections.module';
import { AgentTokenGuard, MCP_TOKEN_SERVICE } from '@app/common/guards/agent-token.guard';
import { CacheProposalService } from './cache-proposal.service';
import { CacheResolverService } from './cache-resolver.service';
import { CacheReadonlyService } from './cache-readonly.service';
import { CacheApplyDispatcher } from './cache-apply.dispatcher';
import { CacheApplyService } from './cache-apply.service';
import { CacheExpirationCron } from './cache-expiration.cron';
import { CacheOutcomeEvaluator } from './cache-outcome-evaluator';
import { CacheProposalController } from './cache-proposal.controller';
import { CacheProposalMcpController } from './cache-proposal-mcp.controller';

const logger = new Logger('CacheProposalsModule');

// Mirror the token-service wiring from McpModule so AgentTokenGuard works
// correctly for CacheProposalMcpController when CLOUD_MODE=true.
let AgentTokensServiceClass: any = null;
if (process.env.CLOUD_MODE === 'true') {
  try {
    const mod = require('../agent/agent-tokens.service');
    AgentTokensServiceClass = mod.AgentTokensService;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'module not found';
    logger.warn(`Agent tokens service failed to load: ${msg}`);
  }
}

const tokenProviders = AgentTokensServiceClass
  ? [AgentTokensServiceClass, { provide: MCP_TOKEN_SERVICE, useExisting: AgentTokensServiceClass }]
  : [];

@Global()
@Module({
  imports: [StorageModule, ConnectionsModule],
  controllers: [CacheProposalController, CacheProposalMcpController],
  providers: [
    AgentTokenGuard,
    ...tokenProviders,
    CacheProposalService,
    CacheResolverService,
    CacheReadonlyService,
    CacheApplyDispatcher,
    CacheApplyService,
    CacheExpirationCron,
    CacheOutcomeEvaluator,
  ],
  exports: [
    CacheProposalService,
    CacheResolverService,
    CacheReadonlyService,
    CacheApplyService,
  ],
})
export class CacheProposalsModule {}
