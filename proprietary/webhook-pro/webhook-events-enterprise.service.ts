import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/license';

/**
 * Webhook Events Enterprise Service - Generates ENTERPRISE tier webhook events
 *
 * This service is in the proprietary folder to ensure OCV compliance.
 * ENTERPRISE tier events are only generated when licensed, while the webhook
 * infrastructure itself (MIT) remains completely open and unrestricted.
 *
 * ENTERPRISE Events Generated:
 * - compliance.alert - Compliance policy violation
 * - audit.policy.violation - ACL command/key policy violation
 * - acl.violation - ACL access violation (runtime)
 * - acl.modified - ACL configuration changed
 * - config.changed - Database configuration changed
 */
@Injectable()
export class WebhookEventsEnterpriseService implements OnModuleInit {
  private readonly logger = new Logger(WebhookEventsEnterpriseService.name);

  constructor(
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly licenseService: LicenseService,
  ) {}

  async onModuleInit() {
    if (this.isEnabled()) {
      this.logger.log('Webhook Enterprise events service initialized - ENTERPRISE tier events enabled');
    } else {
      this.logger.log('Webhook Enterprise events service initialized - ENTERPRISE tier events disabled (requires Enterprise license)');
    }
  }

  /**
   * Check if ENTERPRISE events are enabled
   */
  private isEnabled(): boolean {
    const tier = this.licenseService.getLicenseTier();
    return tier === 'enterprise';
  }

  /**
   * Dispatch compliance alert event (ENTERPRISE)
   * Called when memory is high with noeviction policy (data loss risk)
   */
  async dispatchComplianceAlert(data: {
    complianceType: string;
    severity: string;
    memoryUsedPercent?: number;
    maxmemoryPolicy?: string;
    message: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Compliance alert event skipped - requires ENTERPRISE license');
      return;
    }

    await this.webhookDispatcher.dispatchThresholdAlert(
      WebhookEventType.COMPLIANCE_ALERT,
      'compliance_alert',
      data.memoryUsedPercent || 0,
      80, // threshold
      true, // isAbove
      {
        complianceType: data.complianceType,
        severity: data.severity,
        memoryUsedPercent: data.memoryUsedPercent,
        maxmemoryPolicy: data.maxmemoryPolicy,
        message: data.message,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch audit policy violation event (ENTERPRISE)
   * Called when ACL command or key policy is violated
   */
  async dispatchAuditPolicyViolation(data: {
    username: string;
    clientInfo: string;
    violationType: 'command' | 'key';
    violatedCommand?: string;
    violatedKey?: string;
    count: number;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Audit policy violation event skipped - requires ENTERPRISE license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.AUDIT_POLICY_VIOLATION,
      {
        username: data.username,
        clientInfo: data.clientInfo,
        violationType: data.violationType,
        violatedCommand: data.violatedCommand,
        violatedKey: data.violatedKey,
        count: data.count,
        message: `ACL ${data.violationType} violation by ${data.username}@${data.clientInfo} (count: ${data.count})`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch ACL violation event (ENTERPRISE)
   * Called when runtime ACL access is denied
   */
  async dispatchAclViolation(data: {
    username: string;
    command: string;
    key?: string;
    reason: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('ACL violation event skipped - requires ENTERPRISE license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.ACL_VIOLATION,
      {
        username: data.username,
        command: data.command,
        key: data.key,
        reason: data.reason,
        message: `ACL access denied: ${data.username} attempted ${data.command}${data.key ? ` on ${data.key}` : ''}`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch ACL modified event (ENTERPRISE)
   * Called when ACL configuration is changed
   */
  async dispatchAclModified(data: {
    modifiedBy?: string;
    changeType: 'user_added' | 'user_removed' | 'user_updated' | 'permissions_changed';
    affectedUser?: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('ACL modified event skipped - requires ENTERPRISE license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.ACL_MODIFIED,
      {
        modifiedBy: data.modifiedBy,
        changeType: data.changeType,
        affectedUser: data.affectedUser,
        message: `ACL configuration changed: ${data.changeType}${data.affectedUser ? ` (user: ${data.affectedUser})` : ''}`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }

  /**
   * Dispatch config changed event (ENTERPRISE)
   * Called when database configuration is modified
   */
  async dispatchConfigChanged(data: {
    configKey: string;
    oldValue?: string;
    newValue: string;
    modifiedBy?: string;
    timestamp: number;
    instance: { host: string; port: number };
    connectionId?: string;
  }): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Config changed event skipped - requires ENTERPRISE license');
      return;
    }

    await this.webhookDispatcher.dispatchEvent(
      WebhookEventType.CONFIG_CHANGED,
      {
        configKey: data.configKey,
        oldValue: data.oldValue,
        newValue: data.newValue,
        modifiedBy: data.modifiedBy,
        message: `Configuration changed: ${data.configKey} = ${data.newValue}${data.oldValue ? ` (was: ${data.oldValue})` : ''}`,
        timestamp: data.timestamp,
        instance: data.instance,
      },
      data.connectionId
    );
  }
}
