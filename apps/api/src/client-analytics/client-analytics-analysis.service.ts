import { Injectable, Inject, Logger, HttpException, HttpStatus } from '@nestjs/common';
import {
  StoragePort,
  StoredClientSnapshot,
  CommandDistributionParams,
  CommandDistributionResponse,
  IdleConnectionsParams,
  IdleConnectionsResponse,
  BufferAnomaliesParams,
  BufferAnomaliesResponse,
  ActivityTimelineParams,
  ActivityTimelineResponse,
  SpikeDetectionParams,
  SpikeDetectionResponse,
} from '../common/interfaces/storage-port.interface';

const MAX_SNAPSHOT_LIMIT = 50000;

@Injectable()
export class ClientAnalyticsAnalysisService {
  private readonly logger = new Logger(ClientAnalyticsAnalysisService.name);

  constructor(
    @Inject('STORAGE_CLIENT') private storage: StoragePort,
  ) {}

  async getCommandDistribution(params: CommandDistributionParams, connectionId?: string): Promise<CommandDistributionResponse> {
    const startTime = params.startTime || Date.now() - 60 * 60 * 1000; // 1 hour ago
    const endTime = params.endTime || Date.now();
    const groupBy = params.groupBy || 'client_name';

    let snapshots: StoredClientSnapshot[];
    try {
      snapshots = await this.storage.getClientSnapshots({
        startTime,
        endTime,
        limit: MAX_SNAPSHOT_LIMIT,
        connectionId,
      });
    } catch (error) {
      this.logger.error('Failed to fetch snapshots for command distribution', error);
      throw new HttpException('Failed to fetch analytics data', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const totalSnapshots = snapshots.length;
    const distributionMap = new Map<string, {
      commands: Map<string, number>;
      snapshotCount: number;
    }>();

    // Group by the specified field
    for (const snapshot of snapshots) {
      let identifier = '';
      switch (groupBy) {
        case 'client_name':
          identifier = snapshot.name || '(unnamed)';
          break;
        case 'user':
          identifier = snapshot.user || '(default)';
          break;
        case 'addr':
          identifier = snapshot.addr;
          break;
      }

      if (!distributionMap.has(identifier)) {
        distributionMap.set(identifier, {
          commands: new Map<string, number>(),
          snapshotCount: 0,
        });
      }

      const entry = distributionMap.get(identifier)!;
      entry.snapshotCount++;

      if (snapshot.cmd) {
        const currentCount = entry.commands.get(snapshot.cmd) || 0;
        entry.commands.set(snapshot.cmd, currentCount + 1);
      }
    }

    // Convert to response format
    const distribution = Array.from(distributionMap.entries()).map(([identifier, data]) => {
      const commands: Record<string, number> = {};
      let totalCommands = 0;
      let topCommand = '';
      let topCommandCount = 0;

      data.commands.forEach((count, cmd) => {
        commands[cmd] = count;
        totalCommands += count;
        if (count > topCommandCount) {
          topCommand = cmd;
          topCommandCount = count;
        }
      });

      return {
        identifier,
        commands,
        totalCommands,
        topCommand,
        activityPercentage: totalSnapshots > 0 ? (data.snapshotCount / totalSnapshots) * 100 : 0,
      };
    });

    // Sort by activity percentage descending
    distribution.sort((a, b) => b.activityPercentage - a.activityPercentage);

    return {
      timeRange: { start: startTime, end: endTime },
      totalSnapshots,
      distribution,
    };
  }

  async getIdleConnections(params: IdleConnectionsParams, connectionId?: string): Promise<IdleConnectionsResponse> {
    const idleThresholdSeconds = params.idleThresholdSeconds || 300; // 5 minutes
    const minOccurrences = params.minOccurrences || 10;

    let snapshots: StoredClientSnapshot[];
    try {
      snapshots = await this.storage.getClientSnapshots({
        limit: MAX_SNAPSHOT_LIMIT,
        connectionId,
      });
    } catch (error) {
      this.logger.error('Failed to fetch snapshots for idle connections', error);
      throw new HttpException('Failed to fetch analytics data', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Group by identifier (name or addr) and calculate statistics
    const idleMap = new Map<string, {
      addr: string;
      user: string;
      idleTimes: number[];
      timestamps: number[];
    }>();

    for (const snapshot of snapshots) {
      if (snapshot.idle >= idleThresholdSeconds) {
        const identifier = snapshot.name || snapshot.addr;

        if (!idleMap.has(identifier)) {
          idleMap.set(identifier, {
            addr: snapshot.addr,
            user: snapshot.user,
            idleTimes: [],
            timestamps: [],
          });
        }

        const entry = idleMap.get(identifier)!;
        entry.idleTimes.push(snapshot.idle);
        entry.timestamps.push(snapshot.capturedAt);
      }
    }

    // Filter by minimum occurrences and calculate stats
    const connections = Array.from(idleMap.entries())
      .filter(([_, data]) => data.idleTimes.length >= minOccurrences)
      .map(([identifier, data]) => {
        const avgIdleSeconds = data.idleTimes.reduce((sum, val) => sum + val, 0) / data.idleTimes.length;
        const maxIdleSeconds = Math.max(...data.idleTimes);
        const occurrences = data.idleTimes.length;
        const firstSeen = Math.min(...data.timestamps);
        const lastSeen = Math.max(...data.timestamps);

        return {
          identifier,
          addr: data.addr,
          user: data.user,
          avgIdleSeconds,
          maxIdleSeconds,
          occurrences,
          firstSeen,
          lastSeen,
          recommendation: this.getIdleRecommendation(avgIdleSeconds, occurrences),
        };
      });

    // Sort by average idle time descending
    connections.sort((a, b) => b.avgIdleSeconds - a.avgIdleSeconds);

    const totalIdleConnections = connections.length;
    const potentialWastedResources = `${totalIdleConnections} connections idle >${Math.floor(idleThresholdSeconds / 60)} min`;

    return {
      threshold: idleThresholdSeconds,
      connections,
      summary: {
        totalIdleConnections,
        potentialWastedResources,
      },
    };
  }

  async getBufferAnomalies(params: BufferAnomaliesParams, connectionId?: string): Promise<BufferAnomaliesResponse> {
    const startTime = params.startTime || Date.now() - 60 * 60 * 1000; // 1 hour ago
    const endTime = params.endTime || Date.now();
    const qbufThreshold = params.qbufThreshold || 1000000; // 1MB
    const omemThreshold = params.omemThreshold || 10000000; // 10MB

    let snapshots: StoredClientSnapshot[];
    try {
      snapshots = await this.storage.getClientSnapshots({
        startTime,
        endTime,
        limit: MAX_SNAPSHOT_LIMIT,
        connectionId,
      });
    } catch (error) {
      this.logger.error('Failed to fetch snapshots for buffer anomalies', error);
      throw new HttpException('Failed to fetch analytics data', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Find anomalies and calculate statistics
    const anomalies: BufferAnomaliesResponse['anomalies'] = [];
    const qbufValues: number[] = [];
    const omemValues: number[] = [];

    for (const snapshot of snapshots) {
      qbufValues.push(snapshot.qbuf);
      omemValues.push(snapshot.omem);

      if (snapshot.qbuf > qbufThreshold || snapshot.omem > omemThreshold) {
        const severity = snapshot.omem > omemThreshold * 10 || snapshot.qbuf > qbufThreshold * 10
          ? 'critical'
          : 'warning';

        anomalies.push({
          identifier: snapshot.name || snapshot.addr,
          addr: snapshot.addr,
          timestamp: snapshot.capturedAt,
          qbuf: snapshot.qbuf,
          qbufFree: snapshot.qbufFree,
          obl: snapshot.obl,
          oll: snapshot.oll,
          omem: snapshot.omem,
          lastCommand: snapshot.cmd || '(none)',
          severity,
          recommendation: this.getBufferRecommendation(snapshot.qbuf, snapshot.omem, snapshot.cmd),
        });
      }
    }

    // Sort by timestamp descending (most recent first)
    anomalies.sort((a, b) => b.timestamp - a.timestamp);

    // Calculate statistics
    const avgQbuf = qbufValues.reduce((sum, val) => sum + val, 0) / qbufValues.length || 0;
    const maxQbuf = Math.max(...qbufValues, 0);
    const avgOmem = omemValues.reduce((sum, val) => sum + val, 0) / omemValues.length || 0;
    const maxOmem = Math.max(...omemValues, 0);

    // Calculate 95th percentile
    const sortedQbuf = [...qbufValues].sort((a, b) => a - b);
    const sortedOmem = [...omemValues].sort((a, b) => a - b);
    const p95Index = Math.floor(qbufValues.length * 0.95);
    const p95Qbuf = sortedQbuf[p95Index] || 0;
    const p95Omem = sortedOmem[p95Index] || 0;

    return {
      anomalies,
      stats: {
        avgQbuf,
        maxQbuf,
        avgOmem,
        maxOmem,
        p95Qbuf,
        p95Omem,
      },
    };
  }

  async getActivityTimeline(params: ActivityTimelineParams, connectionId?: string): Promise<ActivityTimelineResponse> {
    const startTime = params.startTime || Date.now() - 60 * 60 * 1000; // 1 hour ago
    const endTime = params.endTime || Date.now();
    const bucketSizeMinutes = params.bucketSizeMinutes || 5;
    const bucketSizeMs = bucketSizeMinutes * 60 * 1000;

    let snapshots: StoredClientSnapshot[];
    try {
      snapshots = await this.storage.getClientSnapshots({
        startTime,
        endTime,
        limit: MAX_SNAPSHOT_LIMIT,
        clientName: params.client,
        connectionId,
      });
    } catch (error) {
      this.logger.error('Failed to fetch snapshots for activity timeline', error);
      throw new HttpException('Failed to fetch analytics data', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Bucket the data
    const bucketMap = new Map<number, {
      clientNames: Set<string>;
      totalConnections: number;
      commandCounts: Map<string, number>;
      idleTimes: number[];
      qbufValues: number[];
      omemValues: number[];
    }>();

    for (const snapshot of snapshots) {
      const bucketTime = Math.floor(snapshot.capturedAt / bucketSizeMs) * bucketSizeMs;

      if (!bucketMap.has(bucketTime)) {
        bucketMap.set(bucketTime, {
          clientNames: new Set<string>(),
          totalConnections: 0,
          commandCounts: new Map<string, number>(),
          idleTimes: [],
          qbufValues: [],
          omemValues: [],
        });
      }

      const bucket = bucketMap.get(bucketTime)!;
      bucket.clientNames.add(snapshot.name || snapshot.addr);
      bucket.totalConnections++;
      bucket.idleTimes.push(snapshot.idle);
      bucket.qbufValues.push(snapshot.qbuf);
      bucket.omemValues.push(snapshot.omem);

      if (snapshot.cmd) {
        const count = bucket.commandCounts.get(snapshot.cmd) || 0;
        bucket.commandCounts.set(snapshot.cmd, count + 1);
      }
    }

    // Convert to response format
    const buckets = Array.from(bucketMap.entries()).map(([timestamp, data]) => {
      const commandBreakdown: Record<string, number> = {};
      data.commandCounts.forEach((count, cmd) => {
        commandBreakdown[cmd] = count;
      });

      const avgIdleSeconds = data.idleTimes.reduce((sum, val) => sum + val, 0) / data.idleTimes.length || 0;
      const maxQbuf = Math.max(...data.qbufValues, 0);
      const maxOmem = Math.max(...data.omemValues, 0);

      return {
        timestamp,
        uniqueClients: data.clientNames.size,
        totalConnections: data.totalConnections,
        commandBreakdown,
        avgIdleSeconds,
        maxQbuf,
        maxOmem,
      };
    });

    // Sort by timestamp ascending
    buckets.sort((a, b) => a.timestamp - b.timestamp);

    return { buckets };
  }

  async detectSpikes(params: SpikeDetectionParams, connectionId?: string): Promise<SpikeDetectionResponse> {
    const startTime = params.startTime || Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago
    const endTime = params.endTime || Date.now();
    const sensitivityMultiplier = params.sensitivityMultiplier || 2;
    const bucketSizeMinutes = 5;
    const bucketSizeMs = bucketSizeMinutes * 60 * 1000;

    // Fetch raw snapshots to identify contributing clients
    let snapshots: StoredClientSnapshot[];
    try {
      snapshots = await this.storage.getClientSnapshots({
        startTime,
        endTime,
        limit: MAX_SNAPSHOT_LIMIT,
        connectionId,
      });
    } catch (error) {
      this.logger.error('Failed to fetch snapshots for spike detection', error);
      throw new HttpException('Failed to fetch analytics data', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // Build per-bucket client breakdown for attribution
    const bucketClientMap = new Map<number, Map<string, number>>();
    for (const snapshot of snapshots) {
      const bucketTime = Math.floor(snapshot.capturedAt / bucketSizeMs) * bucketSizeMs;
      if (!bucketClientMap.has(bucketTime)) {
        bucketClientMap.set(bucketTime, new Map());
      }
      const clientCounts = bucketClientMap.get(bucketTime)!;
      const identifier = snapshot.name || snapshot.addr;
      clientCounts.set(identifier, (clientCounts.get(identifier) || 0) + 1);
    }

    // Get time series data with 5-minute buckets
    const timelineResponse = await this.getActivityTimeline({
      startTime,
      endTime,
      bucketSizeMinutes,
    }, connectionId);

    const buckets = timelineResponse.buckets;

    // Calculate baseline statistics for connections
    const connectionCounts = buckets.map(b => b.totalConnections);
    const avgConnections = connectionCounts.reduce((sum, val) => sum + val, 0) / connectionCounts.length || 0;
    const stdDevConnections = this.calculateStdDev(connectionCounts, avgConnections);
    // Use stdDev-based threshold, but fall back to 50% above average if stdDev is too low
    const minConnectionThreshold = avgConnections * 1.5;
    const stdDevConnectionThreshold = avgConnections + (stdDevConnections * sensitivityMultiplier);
    const connectionThreshold = Math.max(stdDevConnectionThreshold, minConnectionThreshold);

    // Calculate baseline statistics for buffer (omem)
    const omemValues = buckets.map(b => b.maxOmem);
    const avgOmem = omemValues.reduce((sum, val) => sum + val, 0) / omemValues.length || 0;
    const stdDevOmem = this.calculateStdDev(omemValues, avgOmem);
    // Use stdDev-based threshold, but fall back to 2x average if stdDev is too low
    const minBufferThreshold = avgOmem * 2;
    const stdDevBufferThreshold = avgOmem + (stdDevOmem * sensitivityMultiplier);
    const bufferThreshold = Math.max(stdDevBufferThreshold, minBufferThreshold);

    // Calculate commands per minute
    const totalCommands = buckets.reduce((sum, b) =>
      sum + Object.values(b.commandBreakdown).reduce((s, v) => s + v, 0), 0
    );
    const avgCommandsPerMinute = buckets.length > 0 ? totalCommands / (buckets.length * bucketSizeMinutes) : 0;

    // Detect spikes
    const spikes: SpikeDetectionResponse['spikes'] = [];

    for (const bucket of buckets) {
      // Check for connection spikes
      if (bucket.totalConnections > connectionThreshold) {
        const contributingClients = this.getContributingClients(bucketClientMap.get(bucket.timestamp), bucket.totalConnections);
        spikes.push({
          timestamp: bucket.timestamp,
          metric: 'connections',
          value: bucket.totalConnections,
          baseline: avgConnections,
          deviation: bucket.totalConnections - avgConnections,
          contributingClients,
        });
      }

      // Check for buffer spikes (omem)
      if (bucket.maxOmem > bufferThreshold) {
        spikes.push({
          timestamp: bucket.timestamp,
          metric: 'buffer',
          value: bucket.maxOmem,
          baseline: avgOmem,
          deviation: bucket.maxOmem - avgOmem,
          contributingClients: [],
        });
      }
    }

    return {
      spikes,
      baselineStats: {
        avgConnections,
        stdDevConnections,
        avgCommandsPerMinute,
      },
    };
  }

  private getContributingClients(
    clientCounts: Map<string, number> | undefined,
    totalConnections: number,
  ): Array<{ identifier: string; contribution: number }> {
    if (!clientCounts || totalConnections === 0) return [];

    return Array.from(clientCounts.entries())
      .map(([identifier, count]) => ({
        identifier,
        contribution: (count / totalConnections) * 100,
      }))
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 10);
  }

  // Helper methods

  private getIdleRecommendation(avgIdle: number, occurrences: number): string {
    if (avgIdle > 3600 && occurrences > 100) {
      return 'Zombie connection - consider terminating with CLIENT KILL';
    }
    if (avgIdle > 300 && occurrences > 50) {
      return 'Stale connection - review connection pooling settings';
    }
    return 'Monitor - connection occasionally idle';
  }

  private getBufferRecommendation(qbuf: number, omem: number, cmd: string): string {
    if (omem > 100000000) {
      return `Critical: ${cmd || 'command'} generating 100MB+ output - review query or add LIMIT`;
    }
    if (qbuf > 10000000) {
      return `Warning: Large input buffer - client sending oversized commands`;
    }
    if (omem > 10000000) {
      return `Elevated output buffer - ${cmd || 'command'} returning large result set`;
    }
    return 'Elevated buffer usage - monitor for patterns';
  }

  private calculateStdDev(values: number[], mean: number): number {
    if (values.length === 0) return 0;
    const squaredDiffs = values.map(value => Math.pow(value - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
    return Math.sqrt(avgSquaredDiff);
  }
}
