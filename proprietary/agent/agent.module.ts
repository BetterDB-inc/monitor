import { Module } from '@nestjs/common';
import { StorageModule } from '../../apps/api/src/storage/storage.module';
import { AgentGateway } from './agent-gateway';
import { AgentTokensService } from './agent-tokens.service';
import { AgentTokensController } from './agent-tokens.controller';

@Module({
  imports: [StorageModule],
  controllers: [AgentTokensController],
  providers: [AgentGateway, AgentTokensService],
  exports: [AgentGateway],
})
export class AgentModule {}
