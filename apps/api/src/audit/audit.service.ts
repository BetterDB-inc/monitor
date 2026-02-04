import { Injectable, Inject, OnModuleInit, Logger, Optional } from '@nestjs/common';
import { WebhookEventType, IWebhookEventsEnterpriseService, WEBHOOK_EVENTS_ENTERPRISE_SERVICE } from '@betterdb/shared';
import { StoragePort, StoredAclEntry } from '../common/interfaces/storage-port.interface';
import { AclLogEntry } from '../common/types/metrics.types';
import { PrometheusService } from '../prometheus/prometheus.service';
import { SettingsService } from '../settings/settings.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { MultiConnectionPoller, ConnectionContext } from '../common/services/multi-connection-poller';
import { ConnectionRegistry } from '../connections/connection-registry.service';

@Injectable()
export class AuditService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(AuditService.name);

  // Per-connection state: track last seen timestamp for each connection
  private lastSeenTimestamps = new Map<string, number>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storageClient: StoragePort,
    private readonly prometheusService: PrometheusService,
    private readonly settingsService: SettingsService,
    @Optional() private readonly webhookDispatcher?: WebhookDispatcherService,
    @Optional() @Inject(WEBHOOK_EVENTS_ENTERPRISE_SERVICE) private readonly webhookEventsEnterpriseService?: IWebhookEventsEnterpriseService,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.settingsService.getCachedSettings().auditPollIntervalMs;
  }

  async onModuleInit(): Promise<void> {
    if (!this.storageClient.isReady()) {
      this.logger.error('Storage client is not ready');
      return;
    }

    this.start();
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const endTimer = this.prometheusService.startPollTimer('audit', ctx.connectionId);

    try {
      const capabilities = ctx.client.getCapabilities();
      if (!capabilities.hasAclLog) {
        this.logger.debug(`ACL LOG not supported by ${ctx.connectionName}, skipping poll`);
        return;
      }

      // Get ACL log entries
      const aclEntries = await ctx.client.getAclLog(100);

      if (aclEntries.length === 0) {
        return;
      }

      // Get last seen timestamp for this connection
      const lastSeenTimestamp = this.lastSeenTimestamps.get(ctx.connectionId) || 0;

      // Filter out entries we've already seen
      const newEntries = this.deduplicateEntries(aclEntries, lastSeenTimestamp);

      if (newEntries.length === 0) {
        return;
      }

      // Enrich entries with metadata
      const capturedAt = Math.floor(Date.now() / 1000);
      const storedEntries: StoredAclEntry[] = newEntries.map((entry) => ({
        id: 0, // Will be assigned by database
        count: entry.count,
        reason: entry.reason,
        context: entry.context,
        object: entry.object,
        username: entry.username,
        ageSeconds: entry.ageSeconds,
        clientInfo: entry.clientInfo,
        timestampCreated: entry.timestampCreated,
        timestampLastUpdated: entry.timestampLastUpdated,
        capturedAt,
        sourceHost: ctx.host,
        sourcePort: ctx.port,
        connectionId: ctx.connectionId,
      }));

      // Save to storage
      const saved = await this.storageClient.saveAclEntries(storedEntries, ctx.connectionId);
      this.logger.debug(`Saved ${saved} new ACL entries for ${ctx.connectionName}`);

      // Dispatch webhooks for ACL violations
      if (this.webhookDispatcher && newEntries.length > 0) {
        for (const entry of newEntries) {
          const webhookData = {
            reason: entry.reason,
            context: entry.context,
            object: entry.object,
            username: entry.username,
            clientInfo: entry.clientInfo,
            count: entry.count,
            timestamp: entry.timestampLastUpdated,
            host: ctx.host,
            port: ctx.port,
            connectionId: ctx.connectionId,
            connectionName: ctx.connectionName,
          };

          try {
            // Free tier: client.blocked for auth failures
            if (entry.reason === 'auth') {
              await this.webhookDispatcher.dispatchEvent(WebhookEventType.CLIENT_BLOCKED, {
                ...webhookData,
                message: `Client blocked: authentication failure by ${entry.username}@${entry.clientInfo} (count: ${entry.count})`,
              }, ctx.connectionId);

              // Enterprise tier: also dispatch acl.violation for auth denials
              if (this.webhookEventsEnterpriseService) {
                await this.webhookEventsEnterpriseService.dispatchAclViolation({
                  username: entry.username,
                  command: entry.context || 'AUTH',
                  key: entry.object,
                  reason: 'Authentication denied',
                  timestamp: entry.timestampLastUpdated * 1000,
                  instance: { host: ctx.host, port: ctx.port },
                  connectionId: ctx.connectionId,
                });
              }
            }

            // Enterprise tier: audit.policy.violation for command/key violations (handled by proprietary service)
            if ((entry.reason === 'command' || entry.reason === 'key') && this.webhookEventsEnterpriseService) {
              await this.webhookEventsEnterpriseService.dispatchAuditPolicyViolation({
                username: entry.username,
                clientInfo: entry.clientInfo,
                violationType: entry.reason,
                violatedCommand: entry.reason === 'command' ? entry.object : undefined,
                violatedKey: entry.reason === 'key' ? entry.object : undefined,
                count: entry.count,
                timestamp: entry.timestampLastUpdated * 1000, // Convert to ms
                instance: { host: ctx.host, port: ctx.port },
                connectionId: ctx.connectionId,
              });

              // Enterprise tier: also dispatch acl.violation for command/key access denials
              await this.webhookEventsEnterpriseService.dispatchAclViolation({
                username: entry.username,
                command: entry.reason === 'command' ? entry.object : entry.context || 'UNKNOWN',
                key: entry.reason === 'key' ? entry.object : undefined,
                reason: entry.reason === 'command' ? 'Command access denied' : 'Key access denied',
                timestamp: entry.timestampLastUpdated * 1000,
                instance: { host: ctx.host, port: ctx.port },
                connectionId: ctx.connectionId,
              });
            }
          } catch (err) {
            this.logger.error(`Failed to dispatch ACL webhook for ${entry.username}`, err);
          }
        }
      }

      // Update last seen timestamp for this connection
      const latestTimestamp = Math.max(...newEntries.map((e) => e.timestampLastUpdated));
      this.lastSeenTimestamps.set(ctx.connectionId, latestTimestamp);
      this.prometheusService.incrementPollCounter(ctx.connectionId);
    } catch (error) {
      this.logger.error(`Error polling ACL log for ${ctx.connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    } finally {
      endTimer();
    }
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.lastSeenTimestamps.delete(connectionId);
    this.logger.debug(`Cleaned up state for removed connection ${connectionId}`);
  }

  private deduplicateEntries(entries: AclLogEntry[], lastSeenTimestamp: number): AclLogEntry[] {
    // Filter entries that are newer than the last seen timestamp
    return entries.filter((entry) => entry.timestampLastUpdated > lastSeenTimestamp);
  }
}
