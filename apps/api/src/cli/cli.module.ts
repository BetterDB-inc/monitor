import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { CliService } from './cli.service';
import { CliGateway } from './cli.gateway';

@Module({
  imports: [ActivityModule],
  providers: [CliService, CliGateway],
  exports: [CliGateway],
})
export class CliModule {}
