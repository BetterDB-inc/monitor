import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthResponse } from '@betterdb/shared';
import { HealthService } from './health.service';
import { HealthResponseDto } from '../common/dto/health.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Get health status', description: 'Returns the health status of the API server, including Valkey/Redis and storage backend connectivity' })
  @ApiResponse({ status: 200, description: 'Health status retrieved successfully', type: HealthResponseDto })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async getHealth(): Promise<HealthResponse> {
    return this.healthService.getHealth();
  }
}
