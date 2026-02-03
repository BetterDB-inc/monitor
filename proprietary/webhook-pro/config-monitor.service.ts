import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '@app/settings/settings.service';
import { MultiConnectionPoller, ConnectionContext } from '@app/common/services/multi-connection-poller';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { WebhookEventsEnterpriseService } from './webhook-events-enterprise.service';

/**
 * Configuration Monitor Service
 *
 * Monitors ACL and CONFIG changes and dispatches Enterprise tier webhooks
 */
@Injectable()
export class ConfigMonitorService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(ConfigMonitorService.name);
  private readonly POLL_INTERVAL_MS = 30000; // Check every 30 seconds

  // Per-connection cache of previous state
  private previousAclUsers = new Map<string, Set<string>>();
  private previousAclList = new Map<string, Map<string, string>>();
  private previousConfig = new Map<string, Map<string, string>>();
  private initialized = new Map<string, boolean>();

  constructor(
    connectionRegistry: ConnectionRegistry,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly webhookEventsEnterpriseService: WebhookEventsEnterpriseService,
  ) {
    super(connectionRegistry);
  }

  protected getIntervalMs(): number {
    return this.POLL_INTERVAL_MS;
  }

  async onModuleInit() {
    this.logger.log('Configuration monitor service initialized');
    this.start();
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.previousAclUsers.delete(connectionId);
    this.previousAclList.delete(connectionId);
    this.previousConfig.delete(connectionId);
    this.initialized.delete(connectionId);
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    const capabilities = ctx.client.getCapabilities();
    if (!capabilities.hasAclLog) {
      this.logger.debug(`ACL not supported for ${ctx.connectionName}, skipping config monitoring`);
      return;
    }

    // Initialize baseline state for this connection if not already done
    if (!this.initialized.get(ctx.connectionId)) {
      try {
        await this.captureInitialState(ctx);
        this.initialized.set(ctx.connectionId, true);
      } catch (error) {
        this.logger.error(`Failed to capture initial state for ${ctx.connectionName}:`, error);
        return;
      }
    }

    try {
      await Promise.all([
        this.checkAclChanges(ctx),
        this.checkConfigChanges(ctx),
      ]);
    } catch (error) {
      this.logger.error(`Failed to check for changes for ${ctx.connectionName}:`, error);
    }
  }

  private async captureInitialState(ctx: ConnectionContext): Promise<void> {
    try {
      // Capture ACL users
      const aclUsers = await ctx.client.getAclUsers();
      this.previousAclUsers.set(ctx.connectionId, new Set(aclUsers));

      // Capture ACL list
      const aclList = await ctx.client.getAclList();
      const aclMap = new Map<string, string>();
      for (const entry of aclList) {
        const username = this.extractUsername(entry);
        if (username) {
          aclMap.set(username, entry);
        }
      }
      this.previousAclList.set(ctx.connectionId, aclMap);

      // Capture config
      const config = await ctx.client.getConfigValues('*');
      const configMap = new Map<string, string>();
      for (const [key, value] of Object.entries(config)) {
        configMap.set(key, String(value));
      }
      this.previousConfig.set(ctx.connectionId, configMap);

      this.logger.log(
        `Initial state captured for ${ctx.connectionName}: ${aclUsers.length} ACL users, ${configMap.size} config keys`
      );
    } catch (error) {
      this.logger.error(`Failed to capture initial state for ${ctx.connectionName}:`, error);
      throw error;
    }
  }

  private extractUsername(aclEntry: string): string | null {
    // Format: "user <username> <flags...>"
    const match = aclEntry.match(/^user\s+(\S+)/);
    return match ? match[1] : null;
  }

  private async checkAclChanges(ctx: ConnectionContext): Promise<void> {
    try {
      const currentAclUsers = await ctx.client.getAclUsers();
      const currentAclUsersSet = new Set(currentAclUsers);
      const currentAclList = await ctx.client.getAclList();
      const currentAclMap = new Map<string, string>();

      for (const entry of currentAclList) {
        const username = this.extractUsername(entry);
        if (username) {
          currentAclMap.set(username, entry);
        }
      }

      const timestamp = Date.now();
      const instance = {
        host: ctx.host,
        port: ctx.port,
        connectionId: ctx.connectionId,
      };

      const previousAclUsers = this.previousAclUsers.get(ctx.connectionId) || new Set();
      const previousAclList = this.previousAclList.get(ctx.connectionId) || new Map();

      // Check for added users
      for (const user of currentAclUsersSet) {
        if (!previousAclUsers.has(user)) {
          this.logger.log(`ACL user added (${ctx.connectionName}): ${user}`);
          await this.webhookEventsEnterpriseService.dispatchAclModified({
            changeType: 'user_added',
            affectedUser: user,
            timestamp,
            instance,
            connectionId: ctx.connectionId,
          });
        }
      }

      // Check for removed users
      for (const user of previousAclUsers) {
        if (!currentAclUsersSet.has(user)) {
          this.logger.log(`ACL user removed (${ctx.connectionName}): ${user}`);
          await this.webhookEventsEnterpriseService.dispatchAclModified({
            changeType: 'user_removed',
            affectedUser: user,
            timestamp,
            instance,
            connectionId: ctx.connectionId,
          });
        }
      }

      // Check for modified users (permissions changed)
      for (const [user, currentEntry] of currentAclMap) {
        const previousEntry = previousAclList.get(user);
        if (previousEntry && previousEntry !== currentEntry) {
          this.logger.log(`ACL user modified (${ctx.connectionName}): ${user}`);
          await this.webhookEventsEnterpriseService.dispatchAclModified({
            changeType: 'permissions_changed',
            affectedUser: user,
            timestamp,
            instance,
            connectionId: ctx.connectionId,
          });
        }
      }

      // Update cached state
      this.previousAclUsers.set(ctx.connectionId, currentAclUsersSet);
      this.previousAclList.set(ctx.connectionId, currentAclMap);

    } catch (error) {
      this.logger.error(`Failed to check ACL changes for ${ctx.connectionName}:`, error);
    }
  }

  private async checkConfigChanges(ctx: ConnectionContext): Promise<void> {
    try {
      const currentConfig = await ctx.client.getConfigValues('*');
      const timestamp = Date.now();
      const instance = {
        host: ctx.host,
        port: ctx.port,
        connectionId: ctx.connectionId,
      };

      const previousConfig = this.previousConfig.get(ctx.connectionId) || new Map();

      for (const [key, value] of Object.entries(currentConfig)) {
        const currentValue = String(value);
        const previousValue = previousConfig.get(key);

        if (previousValue !== undefined && previousValue !== currentValue) {
          this.logger.log(`Config changed (${ctx.connectionName}): ${key} = ${currentValue} (was: ${previousValue})`);
          await this.webhookEventsEnterpriseService.dispatchConfigChanged({
            configKey: key,
            oldValue: previousValue,
            newValue: currentValue,
            timestamp,
            instance,
            connectionId: ctx.connectionId,
          });
        }

        previousConfig.set(key, currentValue);
      }

      this.previousConfig.set(ctx.connectionId, previousConfig);
    } catch (error) {
      this.logger.error(`Failed to check config changes for ${ctx.connectionName}:`, error);
    }
  }
}
