import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { LogCaptureService } from './log-capture.service';
import { LogCaptureController } from './log-capture.controller';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [LogCaptureService],
  controllers: [LogCaptureController],
  exports: [LogCaptureService],
})
export class LogCaptureModule {}
