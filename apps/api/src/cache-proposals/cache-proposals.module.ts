import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { CacheProposalService } from './cache-proposal.service';
import { CacheResolverService } from './cache-resolver.service';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [CacheProposalService, CacheResolverService],
  exports: [CacheProposalService, CacheResolverService],
})
export class CacheProposalsModule {}
