import { Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { ClusterModule } from '@app/cluster/cluster.module';
import { LicenseModule } from '@proprietary/licenses/license.module';
import { BulkDeleteService } from './bulk-delete.service';
import { BulkDeleteController } from './bulk-delete.controller';

@Module({
  imports: [StorageModule, ClusterModule, LicenseModule],
  providers: [BulkDeleteService],
  controllers: [BulkDeleteController],
  exports: [BulkDeleteService],
})
export class BulkDeleteModule {}
