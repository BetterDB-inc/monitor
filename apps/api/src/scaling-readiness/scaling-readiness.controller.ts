import { Controller, Get } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ScalingReadiness } from '@betterdb/shared';
import { ConnectionId } from '../common/decorators/connection-id.decorator';
import { ENV_DEFAULT_ID } from '../connections/connection-registry.service';
import { ScalingReadinessService } from './scaling-readiness.service';

@ApiTags('scaling-readiness')
@Controller('scaling-readiness')
export class ScalingReadinessController {
  constructor(private readonly service: ScalingReadinessService) {}

  @Get()
  @ApiOperation({ summary: 'Current scaling readiness score for a connection' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async get(@ConnectionId() connectionId?: string): Promise<ScalingReadiness> {
    return this.service.compute(connectionId || ENV_DEFAULT_ID);
  }
}
