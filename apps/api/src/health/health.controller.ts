import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { HealthResponse, DetailedHealthResponse, AllConnectionsHealthResponse } from '@betterdb/shared';
import { HealthService } from './health.service';
import { HealthResponseDto } from '../common/dto/health.dto';
import { ConnectionId } from '../common/decorators';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Get health status', description: 'Returns the health status of the API server, including Valkey/Redis and storage backend connectivity' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target (returns default connection health if not specified)' })
  @ApiResponse({ status: 200, description: 'Health status retrieved successfully', type: HealthResponseDto })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getHealth(@ConnectionId() connectionId?: string): Promise<HealthResponse> {
    return this.healthService.getHealth(connectionId);
  }

  @Get('detailed')
  @ApiOperation({
    summary: 'Get detailed health status',
    description: 'Returns detailed health status including warmup status for anomaly detection, license validation, and uptime',
  })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  @ApiResponse({ status: 200, description: 'Detailed health status retrieved successfully' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getDetailedHealth(@ConnectionId() connectionId?: string): Promise<DetailedHealthResponse> {
    return this.healthService.getDetailedHealth(connectionId);
  }

  @Get('all')
  @ApiOperation({
    summary: 'Get health status for all connections',
    description: 'Returns health status for all registered connections, with an overall status indicator',
  })
  @ApiResponse({ status: 200, description: 'All connections health status retrieved successfully' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getAllConnectionsHealth(): Promise<AllConnectionsHealthResponse> {
    return this.healthService.getAllConnectionsHealth();
  }
}
