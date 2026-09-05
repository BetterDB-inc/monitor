import { Module } from '@nestjs/common';
import { ActivityModule } from '../../../apps/api/src/activity/activity.module';
import { WorkspaceController } from './workspace.controller';
import { EntitlementClientService } from './entitlement-client.service';

@Module({
  imports: [ActivityModule],
  controllers: [WorkspaceController],
  providers: [EntitlementClientService],
  exports: [EntitlementClientService],
})
export class WorkspaceModule {}
