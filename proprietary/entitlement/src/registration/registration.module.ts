import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { EmailModule } from '../email/email.module';
import { RegistrationService } from './registration.service';
import { RegistrationController } from './registration.controller';

@Module({
  imports: [AdminModule, EmailModule],
  controllers: [RegistrationController],
  providers: [RegistrationService],
})
export class RegistrationModule {}
