import { Logger, Module } from '@nestjs/common';
import { KeyAnalyticsService } from './key-analytics.service';
import { KeyAnalyticsController } from './key-analytics.controller';
import { McpKeyAnalyticsController } from './mcp-key-analytics.controller';
import { StorageModule } from '@app/storage/storage.module';
import { LicenseModule } from '@proprietary/licenses/license.module';
import { AgentTokenGuard, MCP_TOKEN_SERVICE } from '@app/common/guards/agent-token.guard';

const logger = new Logger('KeyAnalyticsModule');

// Mirror the token-service wiring from McpModule so AgentTokenGuard works
// correctly for McpKeyAnalyticsController when CLOUD_MODE=true.
let AgentTokensServiceClass: any = null;
if (process.env.CLOUD_MODE === 'true') {
  try {
    const mod = require('../agent/agent-tokens.service');
    AgentTokensServiceClass = mod.AgentTokensService;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'module not found';
    logger.warn(`Agent tokens service failed to load: ${msg}`);
  }
}

const tokenProviders = AgentTokensServiceClass
  ? [AgentTokensServiceClass, { provide: MCP_TOKEN_SERVICE, useExisting: AgentTokensServiceClass }]
  : [];

@Module({
  imports: [StorageModule, LicenseModule],
  providers: [KeyAnalyticsService, AgentTokenGuard, ...tokenProviders],
  controllers: [KeyAnalyticsController, McpKeyAnalyticsController],
  exports: [KeyAnalyticsService],
})
export class KeyAnalyticsModule {}
