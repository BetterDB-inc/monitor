import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CloudAuthGuardImpl } from './cloud-auth.guard';
import { CloudAuthCallbackController } from './auth-callback.controller';
import { WorkspaceModule } from './workspace/workspace.module';

@Global()
@Module({
  imports: [WorkspaceModule],
  controllers: [CloudAuthCallbackController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CloudAuthGuardImpl,
    },
  ],
})
export class ProprietaryCloudAuthModule {}
