import { Global, Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { ConnectionsModule } from '@app/connections/connections.module';
import { CacheProposalService } from './cache-proposal.service';
import { CacheResolverService } from './cache-resolver.service';
import { CacheReadonlyService } from './cache-readonly.service';
import { CacheApplyDispatcher } from './cache-apply.dispatcher';
import { CacheApplyService } from './cache-apply.service';
import { CacheExpirationCron } from './cache-expiration.cron';
import { CacheProposalController } from './cache-proposal.controller';
import { CacheProposalMcpController } from './cache-proposal-mcp.controller';

@Global()
@Module({
  imports: [StorageModule, ConnectionsModule],
  controllers: [CacheProposalController, CacheProposalMcpController],
  providers: [
    CacheProposalService,
    CacheResolverService,
    CacheReadonlyService,
    CacheApplyDispatcher,
    CacheApplyService,
    CacheExpirationCron,
  ],
  exports: [
    CacheProposalService,
    CacheResolverService,
    CacheReadonlyService,
    CacheApplyService,
  ],
})
export class CacheProposalsModule {}
