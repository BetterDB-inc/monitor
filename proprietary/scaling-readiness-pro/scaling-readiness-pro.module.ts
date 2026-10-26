import { Logger, Module } from '@nestjs/common';
import { ConnectionsModule } from '@app/connections/connections.module';
import { StorageModule } from '@app/storage/storage.module';
import { ScalingReadinessModule } from '@app/scaling-readiness/scaling-readiness.module';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { createAgentTokenProviders } from '@app/common/guards/agent-token-providers';
import { ScalingReadinessProController } from './scaling-readiness-pro.controller';
import { ScalingReadinessProService } from './scaling-readiness-pro.service';
import { McpScalingReadinessController } from './mcp-scaling-readiness.controller';

const logger = new Logger('ScalingReadinessProModule');
const tokenProviders = createAgentTokenProviders(logger, () => {
  return require('../agent/agent-tokens.service');
});

@Module({
  imports: [StorageModule, ConnectionsModule, ScalingReadinessModule],
  controllers: [ScalingReadinessProController, McpScalingReadinessController],
  providers: [ScalingReadinessProService, AgentTokenGuard, ...tokenProviders],
})
export class ScalingReadinessProModule {}
