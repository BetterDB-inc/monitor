import { Module, Logger } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { McpController } from './mcp.controller';
import { McpMemoryController } from './memory/mcp-memory.controller';
import { McpMemoryService } from './memory/mcp-memory.service';
import { McpAiController } from './ai/mcp-ai.controller';
import { McpAnalyticsController } from './mcp-analytics.controller';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { createAgentTokenProviders } from '../common/guards/agent-token-providers';
import { MetricsModule } from '../metrics/metrics.module';
import { MetricForecastingModule } from '../metric-forecasting/metric-forecasting.module';
import { CommandLogAnalyticsModule } from '../commandlog-analytics/commandlog-analytics.module';
import { ClientAnalyticsModule } from '../client-analytics/client-analytics.module';
import { ClusterModule } from '../cluster/cluster.module';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { AiObservabilityModule } from '../ai-observability/ai-observability.module';

const logger = new Logger('McpModule');

const tokenProviders = createAgentTokenProviders(logger, () => {
  return require('../../../../proprietary/agent/agent-tokens.service');
});

@Module({
  imports: [
    StorageModule,
    MetricsModule,
    CommandLogAnalyticsModule,
    ClientAnalyticsModule,
    ClusterModule,
    TelemetryModule,
    AiObservabilityModule,
    MetricForecastingModule,
  ],
  controllers: [McpController, McpMemoryController, McpAiController, McpAnalyticsController],
  providers: [AgentTokenGuard, McpMemoryService, ...tokenProviders],
})
export class McpModule {}
