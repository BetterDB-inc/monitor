import { Module } from '@nestjs/common';
import { ConnectionsModule } from '@app/connections/connections.module';
import { StorageModule } from '@app/storage/storage.module';
import { ScalingReadinessModule } from '@app/scaling-readiness/scaling-readiness.module';
import { ScalingReadinessProController } from './scaling-readiness-pro.controller';
import { ScalingReadinessProService } from './scaling-readiness-pro.service';

@Module({
  imports: [StorageModule, ConnectionsModule, ScalingReadinessModule],
  controllers: [ScalingReadinessProController],
  providers: [ScalingReadinessProService],
})
export class ScalingReadinessProModule {}
