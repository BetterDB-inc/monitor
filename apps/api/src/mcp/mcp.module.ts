import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { McpController } from './mcp.controller';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { AgentTokensService } from '../../../../proprietary/agent/agent-tokens.service';
import { MetricsModule } from '../metrics/metrics.module';
import { CommandLogAnalyticsModule } from '../commandlog-analytics/commandlog-analytics.module';
import { ClientAnalyticsModule } from '../client-analytics/client-analytics.module';
import { ClusterModule } from '../cluster/cluster.module';

let AnomalyModule: any = null;
try {
  const mod = require('../../../../proprietary/anomaly-detection/anomaly.module');
  AnomalyModule = mod.AnomalyModule;
} catch {
  // Proprietary anomaly detection not available
}

const optionalImports = [AnomalyModule].filter(Boolean);

@Module({
  imports: [StorageModule, MetricsModule, CommandLogAnalyticsModule, ClientAnalyticsModule, ClusterModule, ...optionalImports],
  controllers: [McpController],
  providers: [AgentTokenGuard, AgentTokensService],
})
export class McpModule {}
