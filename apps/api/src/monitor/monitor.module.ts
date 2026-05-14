import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { AclChecker } from './acl-checker';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorController } from './monitor.controller';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';
import { PreflightService } from './preflight.service';

@Module({
  imports: [ConnectionsModule, StorageModule],
  controllers: [MonitorController],
  providers: [
    AclChecker,
    HealthGateService,
    MonitorCaptureService,
    MonitorDevPreviewGuard,
    PreflightService,
  ],
})
export class MonitorModule {}
