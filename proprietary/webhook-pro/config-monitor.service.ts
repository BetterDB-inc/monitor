import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';
import { SettingsService } from '@app/settings/settings.service';
import { WebhookEventsEnterpriseService } from './webhook-events-enterprise.service';

/**
 * Configuration Monitor Service
 *
 * Monitors ACL and CONFIG changes and dispatches Enterprise tier webhooks
 */
@Injectable()
export class ConfigMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConfigMonitorService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 30000; // Check every 30 seconds

  // Cache previous state
  private previousAclUsers: Set<string> = new Set();
  private previousAclList: Map<string, string> = new Map();
  private previousConfig: Map<string, string> = new Map();
  private initialized = false;

  constructor(
    @Inject('DATABASE_CLIENT')
    private readonly dbClient: DatabasePort,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly webhookEventsEnterpriseService: WebhookEventsEnterpriseService,
  ) {}

  async onModuleInit() {
    const capabilities = this.dbClient.getCapabilities();
    if (!capabilities.hasAclLog) {
      this.logger.warn('ACL not supported, config monitoring disabled');
      return;
    }

    this.logger.log('Configuration monitor service initialized');

    // Initialize baseline state
    try {
      await this.captureInitialState();
      this.initialized = true;
    } catch (error) {
      this.logger.error('Failed to capture initial state:', error);
    }

    this.startPolling();
  }

  onModuleDestroy() {
    this.stopPolling();
  }

  private async captureInitialState(): Promise<void> {
    try {
      // Capture ACL users
      const aclUsers = await this.dbClient.getAclUsers();
      this.previousAclUsers = new Set(aclUsers);

      // Capture ACL list
      const aclList = await this.dbClient.getAclList();
      for (const entry of aclList) {
        // ACL LIST format: "user <username> <flags...>"
        const username = this.extractUsername(entry);
        if (username) {
          this.previousAclList.set(username, entry);
        }
      }

      // Capture config
      const config = await this.dbClient.getConfigValues('*');
      for (const [key, value] of Object.entries(config)) {
        this.previousConfig.set(key, String(value));
      }

      this.logger.log(`Initial state captured: ${this.previousAclUsers.size} ACL users, ${this.previousConfig.size} config keys`);
    } catch (error) {
      this.logger.error('Failed to capture initial state:', error);
      throw error;
    }
  }

  private extractUsername(aclEntry: string): string | null {
    // Format: "user <username> <flags...>"
    const match = aclEntry.match(/^user\s+(\S+)/);
    return match ? match[1] : null;
  }

  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.checkForChanges().catch(error => {
        this.logger.error('Error checking for changes:', error);
      });
    }, this.POLL_INTERVAL_MS);

    // Run immediately after a short delay
    setTimeout(() => {
      this.checkForChanges().catch(error => {
        this.logger.error('Error in initial check:', error);
      });
    }, 5000);
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async checkForChanges(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    try {
      await Promise.all([
        this.checkAclChanges(),
        this.checkConfigChanges(),
      ]);
    } catch (error) {
      this.logger.error('Failed to check for changes:', error);
    }
  }

  private async checkAclChanges(): Promise<void> {
    try {
      const currentAclUsers = await this.dbClient.getAclUsers();
      const currentAclUsersSet = new Set(currentAclUsers);
      const currentAclList = await this.dbClient.getAclList();
      const currentAclMap = new Map<string, string>();

      for (const entry of currentAclList) {
        const username = this.extractUsername(entry);
        if (username) {
          currentAclMap.set(username, entry);
        }
      }

      const timestamp = Date.now();
      const instance = {
        host: this.configService.get<string>('database.host', 'localhost'),
        port: this.configService.get<number>('database.port', 6379),
      };

      // Check for added users
      for (const user of currentAclUsersSet) {
        if (!this.previousAclUsers.has(user)) {
          this.logger.log(`ACL user added: ${user}`);
          await this.webhookEventsEnterpriseService.dispatchAclModified({
            changeType: 'user_added',
            affectedUser: user,
            timestamp,
            instance,
          });
        }
      }

      // Check for removed users
      for (const user of this.previousAclUsers) {
        if (!currentAclUsersSet.has(user)) {
          this.logger.log(`ACL user removed: ${user}`);
          await this.webhookEventsEnterpriseService.dispatchAclModified({
            changeType: 'user_removed',
            affectedUser: user,
            timestamp,
            instance,
          });
        }
      }

      // Check for modified users (permissions changed)
      for (const [user, currentEntry] of currentAclMap) {
        const previousEntry = this.previousAclList.get(user);
        if (previousEntry && previousEntry !== currentEntry) {
          this.logger.log(`ACL user modified: ${user}`);
          await this.webhookEventsEnterpriseService.dispatchAclModified({
            changeType: 'permissions_changed',
            affectedUser: user,
            timestamp,
            instance,
          });
        }
      }

      // Update cached state
      this.previousAclUsers = currentAclUsersSet;
      this.previousAclList = currentAclMap;

    } catch (error) {
      this.logger.error('Failed to check ACL changes:', error);
    }
  }

  private async checkConfigChanges(): Promise<void> {
    try {
      const currentConfig = await this.dbClient.getConfigValues('*');
      const timestamp = Date.now();
      const instance = {
        host: this.configService.get<string>('database.host', 'localhost'),
        port: this.configService.get<number>('database.port', 6379),
      };

      for (const [key, value] of Object.entries(currentConfig)) {
        const currentValue = String(value);
        const previousValue = this.previousConfig.get(key);

        if (previousValue !== undefined && previousValue !== currentValue) {
          this.logger.log(`Config changed: ${key} = ${currentValue} (was: ${previousValue})`);
          await this.webhookEventsEnterpriseService.dispatchConfigChanged({
            configKey: key,
            oldValue: previousValue,
            newValue: currentValue,
            timestamp,
            instance,
          });
        }

        this.previousConfig.set(key, currentValue);
      }
    } catch (error) {
      this.logger.error('Failed to check config changes:', error);
    }
  }
}
