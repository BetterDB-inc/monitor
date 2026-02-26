import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { EntitlementClientService } from './entitlement-client.service';

@Module({
  controllers: [WorkspaceController],
  providers: [EntitlementClientService],
  exports: [EntitlementClientService],
})
export class WorkspaceModule {}
