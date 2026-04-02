import { Injectable, Optional, Inject, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LicenseService } from '@proprietary/licenses';
import { TelemetryPort } from '../common/interfaces/telemetry-port.interface';

@Injectable()
export class UsageTelemetryService implements OnModuleInit {
  private instanceId: string;
  private version: string;
  private tier: string;
  private deploymentMode: string;
  private workspaceName: string | undefined;

  constructor(
    @Inject('TELEMETRY_CLIENT') private readonly telemetryClient: TelemetryPort,
    private readonly configService: ConfigService,
    @Optional() private readonly licenseService?: LicenseService,
  ) {
    this.version =
      this.configService.get<string>('APP_VERSION') ||
      this.configService.get<string>('npm_package_version') ||
      'unknown';
    this.deploymentMode =
      this.configService.get<string>('CLOUD_MODE') === 'true' ? 'cloud' : 'self-hosted';
    this.workspaceName = this.configService.get<string>('TENANT_ID') || undefined;
    this.instanceId = '';
    this.tier = 'community';
  }

  async onModuleInit(): Promise<void> {
    if (!this.licenseService) return;
    await this.licenseService.validationPromise;

    this.instanceId = this.licenseService.getInstanceId();
    this.tier = this.licenseService.getLicenseTier();

    this.telemetryClient.identify(this.instanceId, {
      version: this.version,
      tier: this.tier,
      deploymentMode: this.deploymentMode,
    });

    await this.trackAppStart();
  }

  private sendEvent(eventType: string, payload?: Record<string, unknown>): void {
    if (!this.instanceId) return;
    this.telemetryClient.capture({
      distinctId: this.instanceId,
      event: eventType,
      properties: {
        ...payload,
        version: this.version,
        tier: this.tier,
        deploymentMode: this.deploymentMode,
        workspaceName: this.workspaceName,
        timestamp: Date.now(),
      },
    });
  }

  async trackAppStart(): Promise<void> {
    this.sendEvent('app_start');
  }

  async trackInteractionAfterIdle(idleDurationMs: number): Promise<void> {
    this.sendEvent('interaction_after_idle', { idleDurationMs });
  }

  async trackDbConnect(opts: {
    connectionType: string;
    success: boolean;
    isFirstConnection: boolean;
  }): Promise<void> {
    this.sendEvent('db_connect', opts);
  }

  async trackDbSwitch(totalConnections: number, dbType: string, dbVersion: string): Promise<void> {
    this.sendEvent('db_switch', { totalConnections, dbType, dbVersion });
  }

  async trackPageView(path: string): Promise<void> {
    this.sendEvent('page_view', { path });
  }

  async trackMcpToolCall(event: {
    toolName: string;
    success: boolean;
    durationMs: number;
    error?: string;
  }): Promise<void> {
    this.sendEvent('mcp_tool_call', event);
  }
}
