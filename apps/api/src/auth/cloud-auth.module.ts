import { Module, Global } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CloudAuthGuard } from './cloud-auth.guard';
import { AuthCallbackController } from './auth.controller';

@Global()
@Module({
  controllers: [AuthCallbackController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: CloudAuthGuard,
    },
  ],
})
export class CloudAuthModule { }
