import { Controller, Get, Inject, Optional, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';

@Controller('system')
export class SystemController {
  constructor(
    @Inject('TELEMETRY_CLIENT') @Optional()
    private readonly telemetry: TelemetryPort | null,
  ) {}

  @Get('demo')
  getDemoState(@Req() req: FastifyRequest): { demo: boolean } {
    const demoHost = process.env.DEMO_HOSTNAME;
    if (!demoHost) return { demo: false };

    const isDemo = (req.headers.host || '') === demoHost;

    if (isDemo && this.telemetry) {
      const forwarded = req.headers['x-forwarded-for'] as string | undefined;
      const ip = (forwarded ? forwarded.split(',')[0] : req.ip || 'unknown').trim();
      this.telemetry.capture({
        distinctId: ip,
        event: 'demo_workspace_loaded',
        properties: { $ip: ip, source: 'server_side' },
      });
    }

    return { demo: isDemo };
  }
}
