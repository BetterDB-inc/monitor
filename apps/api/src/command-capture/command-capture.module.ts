import { Module } from '@nestjs/common';
import { CommandCaptureService } from './command-capture.service';
import { CommandCaptureController, CommandCaptureAdminController } from './command-capture.controller';

@Module({
  controllers: [CommandCaptureController, CommandCaptureAdminController],
  providers: [CommandCaptureService],
  exports: [CommandCaptureService],
})
export class CommandCaptureModule {}
