import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StoredCaptureSession } from '../common/interfaces/storage-port.interface';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';

@Controller('monitor')
@UseGuards(MonitorDevPreviewGuard)
export class MonitorController {
  constructor(private readonly captureService: MonitorCaptureService) {}

  @Get('_ping')
  ping(): { ok: true } {
    return { ok: true };
  }

  @Get('sessions')
  listSessions(
    @Query('connectionId') connectionId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredCaptureSession[]> {
    return this.captureService.listSessions({
      connectionId,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }
}
