import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { CacheProposalService } from './cache-proposal.service';
import { CacheResolverService } from './cache-resolver.service';
import { CacheReadonlyService } from './cache-readonly.service';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [CacheProposalService, CacheResolverService, CacheReadonlyService],
  exports: [CacheProposalService, CacheResolverService, CacheReadonlyService],
})
export class CacheProposalsModule {}
