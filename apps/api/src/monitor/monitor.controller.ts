import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StoredCaptureSession } from '../common/interfaces/storage-port.interface';
import { HealthGateResult } from './health-gate';
import { HealthGateService } from './health-gate.service';
import { MonitorCaptureService } from './monitor-capture.service';
import { MonitorDevPreviewGuard } from './monitor-dev-preview.guard';

@Controller('monitor')
@UseGuards(MonitorDevPreviewGuard)
export class MonitorController {
  constructor(
    private readonly captureService: MonitorCaptureService,
    private readonly healthGateService: HealthGateService,
  ) {}

  @Get('_ping')
  ping(): { ok: true } {
    return { ok: true };
  }

  @Get('_diag/health-gate')
  async evaluateHealthGate(
    @Query('connectionId') connectionId?: string,
  ): Promise<HealthGateResult> {
    if (!connectionId) {
      throw new BadRequestException('connectionId query parameter is required');
    }
    return this.healthGateService.evaluate(connectionId);
  }

  @Get('sessions')
  listSessions(
    @Query('connectionId') connectionId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredCaptureSession[]> {
    if (!connectionId) {
      throw new BadRequestException('connectionId query parameter is required');
    }
    return this.captureService.listSessions({
      connectionId,
      limit: parsePositiveInt(limit, 100, 1000),
      offset: parsePositiveInt(offset, 0, Number.MAX_SAFE_INTEGER),
    });
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}
