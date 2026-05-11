import { Controller, Get, UseGuards } from '@nestjs/common';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';

@Controller('monitor')
@UseGuards(MonitorDevPreviewGuard)
export class MonitorController {
  @Get('_ping')
  ping(): { ok: true } {
    return { ok: true };
  }
}
