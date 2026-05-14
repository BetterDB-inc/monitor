import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ClusterModule } from '../cluster/cluster.module';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AclChecker } from './acl-checker';
import { CaptureScheduler } from './capture-scheduler';
import { CaptureTriggerRegistry } from './capture-trigger-registry';
import { CrossReferenceEngine } from './cross-reference.engine';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorController } from './monitor.controller';
import { PreflightService } from './preflight.service';
import { TailGateway } from './tail.gateway';

@Module({
  imports: [
    ClusterModule,
    ConnectionsModule,
    StorageModule,
    WebhooksModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [MonitorController],
  providers: [
    AclChecker,
    CaptureScheduler,
    CaptureTriggerRegistry,
    CrossReferenceEngine,
    HealthGateService,
    MonitorCaptureService,
    PreflightService,
    TailGateway,
  ],
  exports: [TailGateway],
})
export class MonitorModule {}
