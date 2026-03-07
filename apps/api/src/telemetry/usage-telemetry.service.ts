import { Injectable, Optional, OnModuleInit } from '@nestjs/common';
import { LicenseService } from '@proprietary/license';

@Injectable()
export class UsageTelemetryService implements OnModuleInit {
  private telemetryUrl: string;
  private workspaceName: string | null;

  constructor(
    @Optional() private readonly licenseService?: LicenseService,
  ) {
    const entitlementUrl = process.env.ENTITLEMENT_URL || 'https://betterdb.com/api/v1/entitlements';
    const url = new URL(entitlementUrl);
    url.pathname = url.pathname.replace(/\/entitlements$/, '/telemetry');
    this.telemetryUrl = url.toString();
    this.workspaceName = process.env.TENANT_ID || null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.licenseService) return;
    await this.licenseService.validationPromise;
    await this.trackAppStart();
  }

  private async sendEvent(eventType: string, payload?: Record<string, unknown>): Promise<void> {
    try {
      if (!this.licenseService?.isTelemetryEnabled) return;

      const body = {
        instanceId: this.licenseService.getInstanceId(),
        eventType,
        version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
        tier: this.licenseService.getLicenseTier(),
        deploymentMode: process.env.CLOUD_MODE === 'true' ? 'cloud' : 'self-hosted',
        workspaceName: this.workspaceName || undefined,
        timestamp: Date.now(),
        payload,
      };

      await fetch(this.telemetryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // fire-and-forget
    }
  }

  async trackAppStart(): Promise<void> {
    await this.sendEvent('app_start');
  }

  async trackInteractionAfterIdle(idleDurationMs: number): Promise<void> {
    await this.sendEvent('interaction_after_idle', { idleDurationMs });
  }

  async trackDbConnect(opts: { connectionType: string; success: boolean; isFirstConnection: boolean }): Promise<void> {
    await this.sendEvent('db_connect', opts);
  }

  async trackDbSwitch(totalConnections: number, dbType: string, dbVersion: string, host: string): Promise<void> {
    await this.sendEvent('db_switch', { totalConnections, dbType, dbVersion, host });
  }

  async trackPageView(path: string): Promise<void> {
    await this.sendEvent('page_view', { path });
  }
}
