import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorController } from './monitor.controller';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';

@Module({
  imports: [ConnectionsModule, StorageModule],
  controllers: [MonitorController],
  providers: [HealthGateService, MonitorCaptureService, MonitorDevPreviewGuard],
})
export class MonitorModule {}
