import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FleetSummaryResponse } from '@betterdb/shared';
import { FleetService } from './fleet.service';
import { FleetSummaryResponseDto } from './dto/fleet.dto';

@ApiTags('fleet')
@Controller('fleet')
export class FleetController {
  constructor(private readonly fleetService: FleetService) {}

  @Get('summary')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({
    summary: 'Get fleet summary for all connections',
    description:
      'Header-free global route (no X-Connection-Id). Fans out to HealthService + INFO ' +
      'memory/stats per instance with a 5s per-instance timeout; one slow node never ' +
      'blocks the fleet. Result is cached in-memory for 15s.',
  })
  @ApiResponse({ status: 200, description: 'Fleet summary retrieved successfully', type: FleetSummaryResponseDto })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getSummary(): Promise<FleetSummaryResponse> {
    return this.fleetService.getSummary();
  }
}
