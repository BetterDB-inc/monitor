import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorController } from './monitor.controller';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';

@Module({
  imports: [StorageModule],
  controllers: [MonitorController],
  providers: [MonitorCaptureService, MonitorDevPreviewGuard],
  controllers: [MonitorController],
})
export class MonitorModule {}
