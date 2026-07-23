import { Logger, Module } from '@nestjs/common';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import { AnomalyService } from './anomaly.service';
import { AnomalyController } from './anomaly.controller';
import { McpAnomalyController } from './mcp-anomaly.controller';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { createAgentTokenProviders } from '@app/common/guards/agent-token-providers';
import { StorageModule } from '@app/storage/storage.module';
import { PrometheusModule } from '@app/prometheus/prometheus.module';
import { SlowLogAnalyticsModule } from '@app/slowlog-analytics/slowlog-analytics.module';

const logger = new Logger('AnomalyModule');
const tokenProviders = createAgentTokenProviders(logger, () => {
  return require('../agent/agent-tokens.service');
});

@Module({
  imports: [StorageModule, PrometheusModule, SlowLogAnalyticsModule],
  controllers: [AnomalyController, McpAnomalyController],
  providers: [
    AnomalyService,
    AgentTokenGuard,
    ...tokenProviders,
    {
      provide: ANOMALY_SERVICE,
      useExisting: AnomalyService,
    },
  ],
  exports: [AnomalyService, ANOMALY_SERVICE],
})
export class AnomalyModule {}
