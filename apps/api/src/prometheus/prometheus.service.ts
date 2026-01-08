import { Injectable, OnModuleInit, Inject, Logger } from '@nestjs/common';
import { Registry, Gauge, collectDefaultMetrics } from 'prom-client';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { analyzeSlowLogPatterns } from '../metrics/slowlog-analyzer';

@Injectable()
export class PrometheusService implements OnModuleInit {
  private readonly logger = new Logger(PrometheusService.name);
  private registry: Registry;

  // ACL Audit Metrics
  private aclDeniedTotal: Gauge;
  private aclDeniedByReason: Gauge;
  private aclDeniedByUser: Gauge;

  // Client Analytics Metrics
  private clientConnectionsCurrent: Gauge;
  private clientConnectionsByName: Gauge;
  private clientConnectionsByUser: Gauge;
  private clientConnectionsPeak: Gauge;

  // Slowlog Pattern Metrics
  private slowlogPatternCount: Gauge;
  private slowlogPatternDuration: Gauge;
  private slowlogPatternPercentage: Gauge;

  // COMMANDLOG Metrics (Valkey-specific)
  private commandlogLargeRequestCount: Gauge;
  private commandlogLargeReplyCount: Gauge;
  private commandlogLargeRequestByPattern: Gauge;
  private commandlogLargeReplyByPattern: Gauge;

  constructor(
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
    @Inject('DATABASE_CLIENT') private dbClient: DatabasePort,
  ) {
    this.registry = new Registry();
    this.initializeMetrics();
  }

  async onModuleInit(): Promise<void> {
    // Collect default Node.js metrics (memory, CPU, event loop)
    collectDefaultMetrics({ register: this.registry, prefix: 'betterdb_' });
    this.logger.log('Prometheus metrics initialized');
  }

  private initializeMetrics(): void {
    // ACL Audit
    this.aclDeniedTotal = new Gauge({
      name: 'betterdb_acl_denied',
      help: 'Total ACL denied events captured',
      registers: [this.registry],
    });

    this.aclDeniedByReason = new Gauge({
      name: 'betterdb_acl_denied_by_reason',
      help: 'ACL denied events by reason',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.aclDeniedByUser = new Gauge({
      name: 'betterdb_acl_denied_by_user',
      help: 'ACL denied events by username',
      labelNames: ['username'],
      registers: [this.registry],
    });

    // Client Analytics
    this.clientConnectionsCurrent = new Gauge({
      name: 'betterdb_client_connections_current',
      help: 'Current number of client connections',
      registers: [this.registry],
    });

    this.clientConnectionsByName = new Gauge({
      name: 'betterdb_client_connections_by_name',
      help: 'Current connections by client name',
      labelNames: ['client_name'],
      registers: [this.registry],
    });

    this.clientConnectionsByUser = new Gauge({
      name: 'betterdb_client_connections_by_user',
      help: 'Current connections by ACL user',
      labelNames: ['user'],
      registers: [this.registry],
    });

    this.clientConnectionsPeak = new Gauge({
      name: 'betterdb_client_connections_peak',
      help: 'Peak connections in retention period',
      registers: [this.registry],
    });

    // Slowlog Patterns
    this.slowlogPatternCount = new Gauge({
      name: 'betterdb_slowlog_pattern_count',
      help: 'Number of slow queries per pattern',
      labelNames: ['pattern'],
      registers: [this.registry],
    });

    this.slowlogPatternDuration = new Gauge({
      name: 'betterdb_slowlog_pattern_avg_duration_us',
      help: 'Average duration in microseconds per pattern',
      labelNames: ['pattern'],
      registers: [this.registry],
    });

    this.slowlogPatternPercentage = new Gauge({
      name: 'betterdb_slowlog_pattern_percentage',
      help: 'Percentage of slow queries per pattern',
      labelNames: ['pattern'],
      registers: [this.registry],
    });

    // COMMANDLOG (Valkey 8.1+)
    this.commandlogLargeRequestCount = new Gauge({
      name: 'betterdb_commandlog_large_request',
      help: 'Total large request entries',
      registers: [this.registry],
    });

    this.commandlogLargeReplyCount = new Gauge({
      name: 'betterdb_commandlog_large_reply',
      help: 'Total large reply entries',
      registers: [this.registry],
    });

    this.commandlogLargeRequestByPattern = new Gauge({
      name: 'betterdb_commandlog_large_request_by_pattern',
      help: 'Large request count by command pattern',
      labelNames: ['pattern'],
      registers: [this.registry],
    });

    this.commandlogLargeReplyByPattern = new Gauge({
      name: 'betterdb_commandlog_large_reply_by_pattern',
      help: 'Large reply count by command pattern',
      labelNames: ['pattern'],
      registers: [this.registry],
    });
  }

  async updateMetrics(): Promise<void> {
    // Update ACL metrics
    await this.updateAclMetrics();
    // Update client analytics
    await this.updateClientMetrics();
    // Update slowlog patterns
    await this.updateSlowlogMetrics();
    // Update commandlog patterns
    await this.updateCommandlogMetrics();
  }

  private async updateAclMetrics(): Promise<void> {
    try {
      const stats = await this.storage.getAuditStats();

      // Update total
      this.aclDeniedTotal.set(stats.totalEntries);

      // Reset and update by reason
      this.aclDeniedByReason.reset();
      for (const [reason, count] of Object.entries(stats.entriesByReason)) {
        this.aclDeniedByReason.labels(reason).set(count);
      }

      // Reset and update by user
      this.aclDeniedByUser.reset();
      for (const [user, count] of Object.entries(stats.entriesByUser)) {
        this.aclDeniedByUser.labels(user).set(count);
      }
    } catch (error) {
      // ACL audit might not be enabled
      this.logger.debug('ACL audit metrics not available');
    }
  }

  private async updateClientMetrics(): Promise<void> {
    try {
      const stats = await this.storage.getClientAnalyticsStats();

      this.clientConnectionsCurrent.set(stats.currentConnections);
      this.clientConnectionsPeak.set(stats.peakConnections);

      // Reset gauges before updating
      this.clientConnectionsByName.reset();
      this.clientConnectionsByUser.reset();

      for (const [name, data] of Object.entries(stats.connectionsByName)) {
        this.clientConnectionsByName.labels(name || 'unnamed').set(data.current);
      }

      for (const [user, data] of Object.entries(stats.connectionsByUser)) {
        this.clientConnectionsByUser.labels(user).set(data.current);
      }
    } catch (error) {
      // Client analytics might not be enabled
      this.logger.debug('Client analytics metrics not available');
    }
  }

  private async updateSlowlogMetrics(): Promise<void> {
    try {
      const entries = await this.dbClient.getSlowLog(128);
      const analysis = analyzeSlowLogPatterns(entries);

      // Reset all pattern metrics
      this.slowlogPatternCount.reset();
      this.slowlogPatternDuration.reset();
      this.slowlogPatternPercentage.reset();

      // Update with top patterns
      for (const p of analysis.patterns) {
        this.slowlogPatternCount.labels(p.pattern).set(p.count);
        this.slowlogPatternDuration.labels(p.pattern).set(p.avgDuration);
        this.slowlogPatternPercentage.labels(p.pattern).set(p.percentage);
      }
    } catch (error) {
      this.logger.debug('Slowlog metrics not available');
    }
  }

  private async updateCommandlogMetrics(): Promise<void> {
    try {
      const capabilities = this.dbClient.getCapabilities();
      if (!capabilities.hasCommandLog) {
        return;
      }

      // Update large request patterns
      const largeRequests = await this.dbClient.getCommandLog(128, 'large-request');
      const requestAnalysis = analyzeSlowLogPatterns(largeRequests as any);

      this.commandlogLargeRequestByPattern.reset();
      let requestTotal = 0;
      for (const p of requestAnalysis.patterns) {
        this.commandlogLargeRequestByPattern.labels(p.pattern).set(p.count);
        requestTotal += p.count;
      }
      this.commandlogLargeRequestCount.set(requestTotal);

      // Update large reply patterns
      const largeReplies = await this.dbClient.getCommandLog(128, 'large-reply');
      const replyAnalysis = analyzeSlowLogPatterns(largeReplies as any);

      this.commandlogLargeReplyByPattern.reset();
      let replyTotal = 0;
      for (const p of replyAnalysis.patterns) {
        this.commandlogLargeReplyByPattern.labels(p.pattern).set(p.count);
        replyTotal += p.count;
      }
      this.commandlogLargeReplyCount.set(replyTotal);
    } catch (error) {
      this.logger.debug('Commandlog metrics not available');
    }
  }

  async getMetrics(): Promise<string> {
    await this.updateMetrics();
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
