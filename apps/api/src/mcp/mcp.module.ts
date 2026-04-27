import { Module, Logger } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { McpController } from './mcp.controller';
import { AgentTokenGuard, MCP_TOKEN_SERVICE } from '../common/guards/agent-token.guard';
import { MetricsModule } from '../metrics/metrics.module';
import { CommandLogAnalyticsModule } from '../commandlog-analytics/commandlog-analytics.module';
import { ClientAnalyticsModule } from '../client-analytics/client-analytics.module';
import { ClusterModule } from '../cluster/cluster.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { CacheProposalsModule } from '../cache-proposals/cache-proposals.module';

const logger = new Logger('McpModule');

let AgentTokensServiceClass: any = null;
if (process.env.CLOUD_MODE === 'true') {
  try {
    const mod = require('../../../../proprietary/agent/agent-tokens.service');
    AgentTokensServiceClass = mod.AgentTokensService;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'module not found';
    logger.warn(`Agent tokens service failed to load in cloud mode: ${msg}`);
  }
}

let AnomalyModule: any = null;
try {
  const mod = require('../../../../proprietary/anomaly-detection/anomaly.module');
  AnomalyModule = mod.AnomalyModule;
} catch (e) {
  const msg = e instanceof Error ? e.message : 'module not found';
  if (process.env.CLOUD_MODE === 'true') {
    logger.warn(`Anomaly module failed to load in cloud mode: ${msg}`);
  } else {
    logger.debug(`Anomaly module not available: ${msg}`);
  }
}

const tokenProviders = AgentTokensServiceClass
  ? [AgentTokensServiceClass, { provide: MCP_TOKEN_SERVICE, useExisting: AgentTokensServiceClass }]
  : [];

const optionalImports = [AnomalyModule].filter(Boolean);

@Module({
  imports: [StorageModule, MetricsModule, CommandLogAnalyticsModule, ClientAnalyticsModule, ClusterModule, TelemetryModule, CacheProposalsModule, ...optionalImports],
  controllers: [McpController],
  providers: [AgentTokenGuard, ...tokenProviders],
})
export class McpModule {}
