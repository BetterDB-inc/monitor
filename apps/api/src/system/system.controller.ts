import { Controller, Get, Inject, Optional, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import type { WorkspaceStatus } from '@betterdb/shared';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';
import { isCloudMode } from '../common/utils/cloud-mode';
import { WORKSPACE_STATUS, WorkspaceStatusService } from '../workspace/workspace-status.service';
import {
  DefaultDbHost,
  isContainerized,
  resolveDefaultDbHostChecked,
  resolveDefaultDbPort,
} from './runtime.util';

@Controller('system')
export class SystemController {
  private readonly workspaceStatus: WorkspaceStatusService | null;

  constructor(
    @Inject('TELEMETRY_CLIENT')
    @Optional()
    private readonly telemetry: TelemetryPort | null,
    @Inject(WORKSPACE_STATUS)
    @Optional()
    workspaceStatus?: WorkspaceStatusService | null,
  ) {
    this.workspaceStatus = workspaceStatus ?? null;
  }

  @Get('workspace')
  async getWorkspaceStatus(): Promise<WorkspaceStatus> {
    if (this.workspaceStatus !== null) {
      return this.workspaceStatus.getStatus();
    }
    if (isCloudMode()) {
      return { mode: 'cloud', enabled: true, bootstrapped: true };
    }
    return { mode: 'disabled', enabled: false, bootstrapped: false };
  }

  /**
   * Host to pre-fill for a one-click LOCAL connection, resolved for how the
   * monitor is actually running: `localhost` is wrong when the monitor is
   * itself containerized (it points at the container, not the operator's
   * machine). The frontend uses `host`/`port` for the "connect to local
   * instance" button so that a default install (a containerized monitor)
   * reaches the host's database instead of failing. `host.docker.internal` is
   * verified to resolve before it's offered; when it can't, the host is
   * resolved from the container's network mode (loopback under `--network
   * host`, the bridge gateway on a default bridge). See runtime.util for the
   * precedence.
   */
  @Get('connect-defaults')
  async getConnectDefaults(): Promise<DefaultDbHost & { containerized: boolean; port: number }> {
    const containerized = isContainerized();
    const resolved = await resolveDefaultDbHostChecked({
      dbHost: process.env.DB_HOST,
      containerized,
    });
    const port = resolveDefaultDbPort(process.env.DB_PORT);
    return { ...resolved, containerized, port };
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
