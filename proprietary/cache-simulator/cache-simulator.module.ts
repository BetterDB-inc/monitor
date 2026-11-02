import { Logger, Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { ConnectionsModule } from '@app/connections/connections.module';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { createAgentTokenProviders } from '@app/common/guards/agent-token-providers';
import { LicenseModule } from '@proprietary/licenses';
import { CacheSimulatorController } from './cache-simulator.controller';
import { CacheSimulatorService } from './cache-simulator.service';
import { McpCacheSimulatorController } from './mcp-cache-simulator.controller';

const logger = new Logger('CacheSimulatorModule');
const tokenProviders = createAgentTokenProviders(logger, () => {
  return require('../agent/agent-tokens.service');
});

@Module({
  imports: [StorageModule, ConnectionsModule, LicenseModule],
  controllers: [CacheSimulatorController, McpCacheSimulatorController],
  providers: [CacheSimulatorService, AgentTokenGuard, ...tokenProviders],
})
export class CacheSimulatorModule {}
