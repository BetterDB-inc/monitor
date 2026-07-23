import { Logger, Module } from '@nestjs/common';
import { KeyAnalyticsService } from './key-analytics.service';
import { KeyAnalyticsController } from './key-analytics.controller';
import { McpKeyAnalyticsController } from './mcp-key-analytics.controller';
import { StorageModule } from '@app/storage/storage.module';
import { LicenseModule } from '@proprietary/licenses/license.module';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { createAgentTokenProviders } from '@app/common/guards/agent-token-providers';

const logger = new Logger('KeyAnalyticsModule');
const tokenProviders = createAgentTokenProviders(logger, () => {
  return require('../agent/agent-tokens.service');
});

@Module({
  imports: [StorageModule, LicenseModule],
  providers: [KeyAnalyticsService, AgentTokenGuard, ...tokenProviders],
  controllers: [KeyAnalyticsController, McpKeyAnalyticsController],
  exports: [KeyAnalyticsService],
})
export class KeyAnalyticsModule {}
