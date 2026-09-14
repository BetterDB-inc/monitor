import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UserModule } from '../user/user.module';
import { BrokerSigningService } from './broker-signing.service';

@Module({
  imports: [UserModule],
  controllers: [AuthController],
  providers: [AuthService, BrokerSigningService],
  exports: [AuthService],
})
export class AuthModule {}
