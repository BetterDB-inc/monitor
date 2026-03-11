import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { McpController } from './mcp.controller';
import { AgentTokenGuard, MCP_TOKEN_SERVICE } from '../common/guards/agent-token.guard';
import { MetricsModule } from '../metrics/metrics.module';
import { CommandLogAnalyticsModule } from '../commandlog-analytics/commandlog-analytics.module';
import { ClientAnalyticsModule } from '../client-analytics/client-analytics.module';
import { ClusterModule } from '../cluster/cluster.module';

let AgentTokensServiceClass: any = null;
try {
  const mod = require('../../../../proprietary/agent/agent-tokens.service');
  AgentTokensServiceClass = mod.AgentTokensService;
} catch {
  // Community edition - MCP endpoints will be unauthenticated
}

let AnomalyModule: any = null;
try {
  const mod = require('../../../../proprietary/anomaly-detection/anomaly.module');
  AnomalyModule = mod.AnomalyModule;
} catch {
  // Proprietary anomaly detection not available
}

const tokenProviders = AgentTokensServiceClass
  ? [AgentTokensServiceClass, { provide: MCP_TOKEN_SERVICE, useExisting: AgentTokensServiceClass }]
  : [];

const optionalImports = [AnomalyModule].filter(Boolean);

@Module({
  imports: [StorageModule, MetricsModule, CommandLogAnalyticsModule, ClientAnalyticsModule, ClusterModule, ...optionalImports],
  controllers: [McpController],
  providers: [AgentTokenGuard, ...tokenProviders],
})
export class McpModule {}
