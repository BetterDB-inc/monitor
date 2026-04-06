import { Module } from '@nestjs/common';
import { CliService } from './cli.service';
import { CliGateway } from './cli.gateway';

@Module({
  providers: [CliService, CliGateway],
  exports: [CliGateway],
})
export class CliModule {}
