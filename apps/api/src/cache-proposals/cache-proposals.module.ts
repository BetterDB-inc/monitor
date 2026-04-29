import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { CacheProposalService } from './cache-proposal.service';
import { CacheResolverService } from './cache-resolver.service';
import { CacheReadonlyService } from './cache-readonly.service';
import { CacheApplyDispatcher } from './cache-apply.dispatcher';
import { CacheApplyService } from './cache-apply.service';
import { CacheExpirationCron } from './cache-expiration.cron';
import { CacheProposalController } from './cache-proposal.controller';

@Module({
  imports: [StorageModule, ConnectionsModule],
  controllers: [CacheProposalController],
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
