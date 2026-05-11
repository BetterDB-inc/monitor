import { Module } from '@nestjs/common';
import { MonitorController } from './monitor.controller';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';

@Module({
  controllers: [MonitorController],
  providers: [MonitorDevPreviewGuard],
})
export class MonitorModule {}
