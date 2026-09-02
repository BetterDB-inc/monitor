import { Module, Global } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { RetentionPolicyService } from './retention-policy.service';
import { LocalRetentionService } from './local-retention.service';

@Global()
@Module({
  imports: [StorageModule],
  providers: [RetentionPolicyService, LocalRetentionService],
  exports: [RetentionPolicyService],
})
export class RetentionModule {}
