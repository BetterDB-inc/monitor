import { Global, Logger, Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { ConnectionsModule } from '@app/connections/connections.module';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { createAgentTokenProviders } from '@app/common/guards/agent-token-providers';
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

const tokenProviders = createAgentTokenProviders(logger, () => {
  return require('../agent/agent-tokens.service');
});

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
  exports: [CacheProposalService, CacheResolverService, CacheReadonlyService, CacheApplyService],
})
export class CacheProposalsModule {}
