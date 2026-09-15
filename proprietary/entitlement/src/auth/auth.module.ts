import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { BrokerTokenController } from './broker-token.controller';
import { BrokerApiGuard } from './broker-api.guard';
import { BrokerThrottlerGuard } from './broker-throttler.guard';
import { UserModule } from '../user/user.module';
import { BrokerSigningService } from './broker-signing.service';

@Module({
  imports: [UserModule],
  controllers: [AuthController, BrokerTokenController],
  providers: [AuthService, BrokerSigningService, BrokerApiGuard, BrokerThrottlerGuard],
  exports: [AuthService],
})
export class AuthModule {}
