import { Controller, Get, Inject, Optional, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';
import { DefaultDbHost, isContainerized, resolveDefaultDbHost } from './runtime.util';

@Controller('system')
export class SystemController {
  constructor(
    @Inject('TELEMETRY_CLIENT') @Optional()
    private readonly telemetry: TelemetryPort | null,
  ) {}

  /**
   * Host to pre-fill for a one-click LOCAL connection, resolved for how the
   * monitor is actually running: `localhost` is wrong when the monitor is
   * itself containerized (it points at the container, not the operator's
   * machine). The frontend uses `host` for the "connect to local instance"
   * button so that default install (a containerized monitor) reaches the
   * host's database instead of failing. See runtime.util for the precedence.
   */
  @Get('connect-defaults')
  getConnectDefaults(): DefaultDbHost & { containerized: boolean } {
    const containerized = isContainerized();
    const resolved = resolveDefaultDbHost({ dbHost: process.env.DB_HOST, containerized });
    return { ...resolved, containerized };
  }

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
