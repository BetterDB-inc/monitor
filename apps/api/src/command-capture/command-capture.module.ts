import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { CommandCaptureService } from './command-capture.service';
import { CommandCaptureController, CommandCaptureAdminController } from './command-capture.controller';

@Module({
  imports: [StorageModule, ConnectionsModule],
  controllers: [CommandCaptureController, CommandCaptureAdminController],
  providers: [CommandCaptureService],
  exports: [CommandCaptureService],
})
export class CommandCaptureModule {}
