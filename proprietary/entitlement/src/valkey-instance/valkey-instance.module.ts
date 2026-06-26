import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ValkeyInstanceService } from './valkey-instance.service';
import { ValkeyInstanceController } from './valkey-instance.controller';
import { ProvisioningModule } from '../provisioning/provisioning.module';

@Module({
  imports: [ConfigModule, ProvisioningModule],
  controllers: [ValkeyInstanceController],
  providers: [ValkeyInstanceService],
  exports: [ValkeyInstanceService],
})
export class ValkeyInstanceModule {}
