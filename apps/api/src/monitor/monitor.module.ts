import { Module } from '@nestjs/common';
import { ClusterModule } from '../cluster/cluster.module';
import { ConnectionsModule } from '../connections/connections.module';
import { StorageModule } from '../storage/storage.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AclChecker } from './acl-checker';
import { CrossReferenceEngine } from './cross-reference.engine';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorController } from './monitor.controller';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';
import { PreflightService } from './preflight.service';
import { TailGateway } from './tail.gateway';

@Module({
  imports: [ClusterModule, ConnectionsModule, StorageModule, WebhooksModule],
  controllers: [MonitorController],
  providers: [
    AclChecker,
    CrossReferenceEngine,
    HealthGateService,
    MonitorCaptureService,
    MonitorDevPreviewGuard,
    PreflightService,
    TailGateway,
  ],
  exports: [TailGateway],
})
export class MonitorModule {}
