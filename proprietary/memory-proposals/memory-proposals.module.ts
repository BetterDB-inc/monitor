import { Global, Logger, Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { ConnectionsModule } from '@app/connections/connections.module';
import { AgentTokenGuard, MCP_TOKEN_SERVICE } from '@app/common/guards/agent-token.guard';
import { MemoryProposalService } from './memory-proposal.service';
import { MemoryApplyDispatcher } from './memory-apply.dispatcher';
import { MemoryApplyService } from './memory-apply.service';
import { MemoryExpirationCron } from './memory-expiration.cron';
import { MemoryProposalMcpController } from './memory-proposal-mcp.controller';

const logger = new Logger('MemoryProposalsModule');

// Mirror the token-service wiring from McpModule so AgentTokenGuard works
// correctly for MemoryProposalMcpController when CLOUD_MODE=true.
let AgentTokensServiceClass: unknown = null;
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
  ? [
      AgentTokensServiceClass as new (...args: never[]) => unknown,
      { provide: MCP_TOKEN_SERVICE, useExisting: AgentTokensServiceClass as never },
    ]
  : [];

@Global()
@Module({
  imports: [StorageModule, ConnectionsModule],
  controllers: [MemoryProposalMcpController],
  providers: [
    AgentTokenGuard,
    ...tokenProviders,
    MemoryProposalService,
    MemoryApplyDispatcher,
    MemoryApplyService,
    MemoryExpirationCron,
  ],
  exports: [MemoryProposalService, MemoryApplyService],
})
export class MemoryProposalsModule {}
