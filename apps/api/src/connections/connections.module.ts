import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '../storage/storage.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { ConnectionRegistry } from './connection-registry.service';
import { ConnectionsController } from './connections.controller';
import { RuntimeCapabilityTracker } from './runtime-capability-tracker.service';
import { SshTunnelService } from '../database/ssh/ssh-tunnel.service';
import { ExternalMetricsStoreModule } from '../external-metrics/external-metrics-store.module';

@Global()
@Module({
  imports: [ConfigModule, StorageModule, TelemetryModule, ExternalMetricsStoreModule],
  controllers: [ConnectionsController],
  providers: [ConnectionRegistry, RuntimeCapabilityTracker, SshTunnelService],
  exports: [ConnectionRegistry, RuntimeCapabilityTracker],
})
export class ConnectionsModule {}
