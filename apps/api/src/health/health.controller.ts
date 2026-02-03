import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { HealthResponse, DetailedHealthResponse, AllConnectionsHealthResponse } from '@betterdb/shared';
import { HealthService } from './health.service';
import { HealthResponseDto } from '../common/dto/health.dto';
import { AllConnectionsHealthResponseDto } from '../common/dto/connections.dto';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Get health status',
    description: 'Returns the health status of the API server for a specific connection. If no connection ID is provided, uses the default connection.',
  })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to target (returns default connection health if not specified)' })
  @ApiResponse({ status: 200, description: 'Health status retrieved successfully', type: HealthResponseDto })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getHealth(@ConnectionId() connectionId?: string): Promise<HealthResponse> {
    return this.healthService.getHealth(connectionId);
  }

  @Get('detailed')
  @ApiOperation({
    summary: 'Get detailed health status',
    description: 'Returns detailed health status including warmup status for anomaly detection, license validation, and uptime for a specific connection.',
  })
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Detailed health status retrieved successfully' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getDetailedHealth(@ConnectionId() connectionId?: string): Promise<DetailedHealthResponse> {
    return this.healthService.getDetailedHealth(connectionId);
  }

  @Get('all')
  @ApiOperation({
    summary: 'Get health status for all connections',
    description: 'Returns health status for all registered database connections, with an overall status indicator (healthy/degraded/unhealthy).',
  })
  @ApiResponse({ status: 200, description: 'All connections health status retrieved successfully', type: AllConnectionsHealthResponseDto })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getAllConnectionsHealth(): Promise<AllConnectionsHealthResponse> {
    return this.healthService.getAllConnectionsHealth();
  }
}
