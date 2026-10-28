import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  CAPTURED_LOG_TYPES,
  type CapturedLogType,
  type LogCaptureGap,
  type LogCaptureSummary,
} from '@betterdb/shared';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';
import { LogCaptureService } from './log-capture.service';

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_WINDOW_HOURS = 24;
export const MAX_WINDOW_HOURS = 30 * 24;

function parseOptionalInt(name: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseLogType(raw: string | undefined): CapturedLogType | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(CAPTURED_LOG_TYPES as readonly string[]).includes(raw)) {
    throw new BadRequestException(`logType must be one of: ${CAPTURED_LOG_TYPES.join(', ')}`);
  }
  return raw as CapturedLogType;
}

@ApiTags('log-capture')
@Controller('log-capture')
export class LogCaptureController {
  constructor(private readonly service: LogCaptureService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Slow log / command log entries the server evicted before BetterDB could read them',
  })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false })
  @ApiQuery({
    name: 'windowHours',
    required: false,
    description: `Look-back window in hours (1-${MAX_WINDOW_HOURS}, default ${DEFAULT_WINDOW_HOURS})`,
  })
  async getSummary(
    @ConnectionId() connectionId?: string,
    @Query('windowHours') windowHours?: string,
  ): Promise<LogCaptureSummary> {
    const hours = parseOptionalInt('windowHours', windowHours, 1, MAX_WINDOW_HOURS) ?? DEFAULT_WINDOW_HOURS;
    return this.service.getSummary(connectionId, hours * HOUR_MS);
  }

  @Get('gaps')
  @ApiOperation({ summary: 'Individual capture gaps, newest first' })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false })
  @ApiQuery({ name: 'logType', required: false, enum: CAPTURED_LOG_TYPES as unknown as string[] })
  @ApiQuery({ name: 'startTime', required: false, description: 'Lower bound on detection time (epoch ms)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Upper bound on detection time (epoch ms)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum rows (1-1000, default 100)' })
  async getGaps(
    @ConnectionId() connectionId?: string,
    @Query('logType') logType?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
  ): Promise<LogCaptureGap[]> {
    return this.service.listGaps(connectionId, {
      logType: parseLogType(logType),
      since: parseOptionalInt('startTime', startTime, 0, Number.MAX_SAFE_INTEGER),
      until: parseOptionalInt('endTime', endTime, 0, Number.MAX_SAFE_INTEGER),
      limit: parseOptionalInt('limit', limit, 1, 1000) ?? 100,
    });
  }
}
