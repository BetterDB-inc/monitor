import { randomUUID } from 'crypto';
import {
  clientRollupBucketStart,
  DEFAULT_RETRY_POLICY,
  DeliveryStatus,
  WebhookEventType,
} from '@betterdb/shared';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';
import { hasRawDatabaseHandle } from '../../storage/raw-database-handle';

export interface SweepFixtureTimes {
  expiredAtMs: number;
  recentAtMs: number;
}

/**
 * Two rows of one swept store, written through the store's own save method: one whose
 * prune-relevant time is `expiredAtMs` and one at `recentAtMs`. `remainingAtMs` returns that
 * time, in milliseconds, for each of them the store still returns. A store that keeps whole
 * seconds returns the last millisecond of the row's second, because the sweep keeps every row
 * of the second the cutoff falls in.
 */
export interface SweepFixture {
  seed(storage: StoragePort, times: SweepFixtureTimes): Promise<void>;
  remainingAtMs(storage: StoragePort): Promise<number[]>;
}

const CONNECTION_ID = 'sweep-fixture-conn';
const ALL_TIME = { startTime: 0, endTime: Number.MAX_SAFE_INTEGER };
const MINUTE_MS = 60_000;
const COMMAND = 'GET';
const CHUNK_SESSION_ID = randomUUID();
const OTEL_TRACE_IDS = ['a'.repeat(32), 'b'.repeat(32)];

const ages = ({ expiredAtMs, recentAtMs }: SweepFixtureTimes): number[] => [
  expiredAtMs,
  recentAtMs,
];

const toSeconds = (ms: number): number => Math.floor(ms / 1000);
const toMs = (seconds: number): number => seconds * 1000;
const lastMsOfSecond = (seconds: number): number => toMs(seconds) + 999;

async function withClockAt<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(ms);
  try {
    return await run();
  } finally {
    clock.mockRestore();
  }
}

// PostgreSQL stamps created_at from its own clock, which the Date.now spy cannot reach.
async function backdatePostgresDelivery(
  storage: StoragePort,
  deliveryId: string,
  createdAtMs: number,
): Promise<void> {
  if (!hasRawDatabaseHandle(storage)) return;
  const handle = storage.getRawDatabaseHandle();
  if (handle.kind !== 'postgres') return;
  await handle.pool.query(
    'UPDATE webhook_deliveries SET created_at = to_timestamp($1 / 1000.0) WHERE id = $2',
    [createdAtMs, deliveryId],
  );
}

export const sweepFixtures: Record<string, SweepFixture> = {
  slowlog: {
    seed: async (storage, times) => {
      await storage.saveSlowLogEntries(
        ages(times).map((capturedAt, index) => ({
          id: index + 1,
          timestamp: toSeconds(capturedAt),
          duration: 15_000,
          command: [COMMAND, 'key'],
          clientAddress: '10.0.0.1:5000',
          clientName: 'app',
          capturedAt,
          sourceHost: 'localhost',
          sourcePort: 6379,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getSlowLogEntries({ connectionId: CONNECTION_ID })).map(
        (row) => row.capturedAt,
      ),
  },

  commandlog: {
    seed: async (storage, times) => {
      await storage.saveCommandLogEntries(
        ages(times).map((capturedAt, index) => ({
          id: index + 1,
          timestamp: toSeconds(capturedAt),
          duration: 15_000,
          command: [COMMAND, 'key'],
          clientAddress: '10.0.0.1:5000',
          clientName: 'app',
          type: 'slow' as const,
          capturedAt,
          sourceHost: 'localhost',
          sourcePort: 6379,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getCommandLogEntries({ connectionId: CONNECTION_ID })).map(
        (row) => row.capturedAt,
      ),
  },

  client_snapshots: {
    seed: async (storage, times) => {
      await storage.saveClientSnapshot(
        ages(times).map((capturedAt, index) => ({
          id: 0,
          clientId: `client-${index}`,
          addr: `10.0.0.1:${5000 + index}`,
          name: 'app',
          user: 'default',
          db: 0,
          cmd: 'get',
          age: 100,
          idle: 0,
          flags: 'N',
          sub: 0,
          psub: 0,
          qbuf: 0,
          qbufFree: 0,
          obl: 0,
          oll: 0,
          omem: 0,
          capturedAt,
          sourceHost: 'localhost',
          sourcePort: 6379,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getClientSnapshots({ connectionId: CONNECTION_ID })).map(
        (row) => row.capturedAt,
      ),
  },

  client_analytics_rollups: {
    seed: async (storage, times) => {
      await storage.upsertClientAnalyticsRollups(
        ages(times).map((capturedAt) => ({
          connectionId: CONNECTION_ID,
          bucketStart: clientRollupBucketStart(capturedAt),
          firstCapturedAt: capturedAt,
          lastCapturedAt: capturedAt,
          batchCount: 1,
          rowCount: 1,
          lastConnections: 1,
          peakConnections: 1,
          peakCapturedAt: capturedAt,
          byName: { app: { last: 1, peak: 1, ageSum: 100, rows: 1 } },
          byUser: { default: { last: 1, peak: 1 } },
          byUserAndName: {},
          ips: ['10.0.0.1'],
          updatedAt: capturedAt,
        })),
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getClientAnalyticsRollups(0, Number.MAX_SAFE_INTEGER, CONNECTION_ID)).map(
        (row) => row.bucketStart,
      ),
  },

  anomaly_events: {
    seed: async (storage, times) => {
      await storage.saveAnomalyEvents(
        ages(times).map((timestamp) => ({
          id: randomUUID(),
          timestamp,
          metricType: 'connections',
          anomalyType: 'spike',
          severity: 'warning',
          value: 100,
          baseline: 10,
          stdDev: 2,
          zScore: 45,
          threshold: 3,
          message: 'connections spiked',
          resolved: false,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getAnomalyEvents({ connectionId: CONNECTION_ID })).map((row) => row.timestamp),
  },

  correlated_groups: {
    seed: async (storage, times) => {
      for (const timestamp of ages(times)) {
        await storage.saveCorrelatedGroup(
          {
            correlationId: randomUUID(),
            timestamp,
            pattern: 'memory_pressure',
            severity: 'warning',
            diagnosis: 'memory pressure',
            recommendations: ['add memory'],
            anomalyCount: 2,
            metricTypes: ['memory_used', 'evicted_keys'],
          },
          CONNECTION_ID,
        );
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getCorrelatedGroups({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  incident_boundaries: {
    seed: async (storage, times) => {
      await storage.saveIncidentBoundaries(
        ages(times).map((startedAt) => ({
          scopeId: CONNECTION_ID,
          startedAt,
          anomalyId: randomUUID(),
        })),
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getIncidentBoundaries({ scopeIds: [CONNECTION_ID], startTime: 0 })).map(
        (row) => row.startedAt,
      ),
  },

  key_patterns: {
    seed: async (storage, times) => {
      await storage.saveKeyPatternSnapshots(
        ages(times).map((timestamp) => ({
          id: randomUUID(),
          timestamp,
          pattern: 'user:*',
          keyCount: 10,
          sampledKeyCount: 10,
          keysWithTtl: 0,
          keysExpiringSoon: 0,
          totalMemoryBytes: 1_000,
          avgMemoryBytes: 100,
          maxMemoryBytes: 200,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getKeyPatternSnapshots({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  hot_keys: {
    seed: async (storage, times) => {
      await storage.saveHotKeys(
        ages(times).map((capturedAt) => ({
          id: randomUUID(),
          keyName: 'user:1',
          connectionId: CONNECTION_ID,
          capturedAt,
          signalType: 'lfu' as const,
          freqScore: 200,
          rank: 1,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getHotKeys({ connectionId: CONNECTION_ID })).map((row) => row.capturedAt),
  },

  acl_entries: {
    seed: async (storage, times) => {
      await storage.saveAclEntries(
        ages(times)
          .map(toSeconds)
          .map((capturedAt) => ({
            id: 0,
            count: 1,
            reason: 'auth',
            context: 'toplevel',
            object: 'AUTH',
            username: 'app',
            ageSeconds: 1,
            clientInfo: 'id=1 addr=10.0.0.1:5000',
            timestampCreated: capturedAt,
            timestampLastUpdated: capturedAt,
            capturedAt,
            sourceHost: 'localhost',
            sourcePort: 6379,
          })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getAclEntries({ connectionId: CONNECTION_ID })).map((row) =>
        lastMsOfSecond(row.capturedAt),
      ),
  },

  webhook_deliveries: {
    seed: async (storage, times) => {
      const webhook = await storage.createWebhook({
        name: 'sweep fixture',
        url: 'https://example.com/hook',
        enabled: true,
        events: [WebhookEventType.INSTANCE_DOWN],
        headers: {},
        retryPolicy: DEFAULT_RETRY_POLICY,
        connectionId: CONNECTION_ID,
      });
      for (const createdAt of ages(times)) {
        // createDelivery takes no createdAt and stamps it from the clock.
        const delivery = await withClockAt(createdAt, () =>
          storage.createDelivery({
            webhookId: webhook.id,
            eventType: WebhookEventType.INSTANCE_DOWN,
            payload: {
              event: WebhookEventType.INSTANCE_DOWN,
              timestamp: createdAt,
              data: { message: 'instance down' },
            },
            status: DeliveryStatus.SUCCESS,
            attempts: 1,
            connectionId: CONNECTION_ID,
          }),
        );
        await backdatePostgresDelivery(storage, delivery.id, createdAt);
      }
    },
    remainingAtMs: async (storage) => {
      const webhooks = await storage.getWebhooksByInstance(CONNECTION_ID);
      const deliveries = await Promise.all(
        webhooks.map((webhook) => storage.getDeliveriesByWebhook(webhook.id)),
      );
      return deliveries.flat().map((row) => row.createdAt);
    },
  },

  latency_snapshots: {
    seed: async (storage, times) => {
      await storage.saveLatencySnapshots(
        ages(times).map((timestamp) => ({
          id: randomUUID(),
          timestamp,
          eventName: 'command',
          latestEventTimestamp: toSeconds(timestamp),
          maxLatency: 1_500,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getLatencySnapshots({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  latency_histograms: {
    seed: async (storage, times) => {
      for (const timestamp of ages(times)) {
        await storage.saveLatencyHistogram(
          {
            id: randomUUID(),
            timestamp,
            data: { [COMMAND]: { calls: 10, histogram: { '1': 4, '2': 6 } } },
          },
          CONNECTION_ID,
        );
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getLatencyHistograms({ connectionId: CONNECTION_ID, limit: 10 })).map(
        (row) => row.timestamp,
      ),
  },

  memory_snapshots: {
    seed: async (storage, times) => {
      await storage.saveMemorySnapshots(
        ages(times).map((timestamp) => ({
          id: randomUUID(),
          timestamp,
          usedMemory: 1_000_000,
          usedMemoryRss: 1_200_000,
          usedMemoryPeak: 1_500_000,
          memFragmentationRatio: 1.2,
          maxmemory: 0,
          allocatorFragRatio: 1.01,
          opsPerSec: 100,
          cpuSys: 1,
          cpuUser: 2,
          ioThreadedReads: 0,
          ioThreadedWrites: 0,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getMemorySnapshots({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  scaling_readiness_scores: {
    seed: async (storage, times) => {
      for (const timestamp of ages(times)) {
        await storage.saveScalingReadinessScore({
          id: randomUUID(),
          connectionId: CONNECTION_ID,
          timestamp,
          score: 80,
          band: 'green',
          bindingDimension: 'memory',
          dimensions: [
            {
              key: 'memory',
              score: 80,
              weight: 1,
              contribution: 80,
              detail: null,
              excludedReason: null,
            },
          ],
        });
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getScalingReadinessScores({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  kv_cache_footprint_snapshots: {
    seed: async (storage, times) => {
      for (const timestamp of ages(times)) {
        await storage.saveKvCacheFootprintSnapshot({
          connectionId: CONNECTION_ID,
          timestamp,
          detected: true,
          layout: 'single_key',
          scannedKeys: 100,
          matchedKeys: 10,
          sampledKeys: 10,
          scanComplete: true,
          primariesScanned: 1,
          primariesTotal: 1,
          chunksEst: 10,
          bytesEst: 36_701_120,
          usedMemory: 40_000_000,
          maxmemory: 0,
          maxmemoryPolicy: 'noeviction',
          lmcacheMemoryShare: 0.92,
          noTtlRatio: 1,
          orphanRatio: null,
          evictedKeysDelta: null,
          evictedKeysIntervalMs: null,
          otherDbs: [],
          perModel: [],
        });
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getKvCacheFootprintSnapshots({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  kv_cache_engine_samples: {
    seed: async (storage, times) => {
      await storage.saveKvCacheEngineSamples(
        ages(times).map((timestamp) => ({
          engineId: 'eng-1',
          connectionId: CONNECTION_ID,
          modelName: 'm',
          timestamp,
          requestedTokens: 1_000,
          hitTokens: 700,
          lookupTokens: 1_000,
          lookupHits: 3,
          remoteReadBytes: 10,
          remoteWriteBytes: 20,
          remoteReadRequests: 1,
          remoteWriteRequests: 2,
          remotePingErrors: 0,
        })),
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getKvCacheEngineSamples({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  capture_chunks: {
    seed: async (storage, times) => {
      // The parent session stays running, so the sweep leaves it and only the chunks' own
      // age decides which of them go.
      await storage.saveCaptureSession(
        {
          id: CHUNK_SESSION_ID,
          connectionId: CONNECTION_ID,
          status: 'running',
          source: 'manual',
          startedAt: times.expiredAtMs - MINUTE_MS,
          byteCount: 0,
          lineCount: 0,
          byteCap: 1_000_000,
          lineCap: 10_000,
        },
        CONNECTION_ID,
      );
      for (const [chunkIndex, lastTs] of ages(times).entries()) {
        await storage.saveCaptureChunk({
          sessionId: CHUNK_SESSION_ID,
          chunkIndex,
          bytes: Buffer.from(`+${toSeconds(lastTs)}.000000 [0 10.0.0.1:5000] "GET" "key"\n`),
          lineCount: 1,
          firstTs: lastTs - MINUTE_MS,
          lastTs,
        });
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getCaptureChunks(CHUNK_SESSION_ID)).map((row) => row.lastTs),
  },

  capture_sessions: {
    seed: async (storage, times) => {
      for (const endedAt of ages(times)) {
        await storage.saveCaptureSession(
          {
            id: randomUUID(),
            connectionId: CONNECTION_ID,
            status: 'completed',
            source: 'manual',
            startedAt: endedAt - MINUTE_MS,
            endedAt,
            durationMs: MINUTE_MS,
            byteCount: 0,
            lineCount: 0,
            byteCap: 1_000_000,
            lineCap: 10_000,
          },
          CONNECTION_ID,
        );
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getCaptureSessions({ connectionId: CONNECTION_ID })).map(
        (row) => row.endedAt ?? row.startedAt,
      ),
  },

  capture_triggers: {
    seed: async (storage, times) => {
      for (const createdAt of ages(times)) {
        await storage.saveCaptureTrigger({
          id: randomUUID(),
          connectionId: CONNECTION_ID,
          metricType: 'connections',
          anomalyType: 'spike',
          expiresAt: createdAt + MINUTE_MS,
          createdAt,
          status: 'expired',
        });
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getCaptureTriggers({ connectionId: CONNECTION_ID })).map(
        (row) => row.createdAt,
      ),
  },

  scheduled_captures: {
    seed: async (storage, times) => {
      for (const createdAt of ages(times)) {
        await storage.saveScheduledCapture({
          id: randomUUID(),
          connectionId: CONNECTION_ID,
          intervalSeconds: 3_600,
          durationMs: 1_000,
          status: 'disabled',
          createdAt,
        });
      }
    },
    remainingAtMs: async (storage) =>
      (await storage.getScheduledCaptures({ connectionId: CONNECTION_ID })).map(
        (row) => row.createdAt,
      ),
  },

  ai_cache_samples: {
    seed: async (storage, times) => {
      await storage.saveAiCacheSamples(
        ages(times).map((timestamp) => ({
          instanceField: 'myapp',
          instanceName: 'myapp',
          kind: 'semantic_cache' as const,
          timestamp,
          hits: 7,
          misses: 3,
          hitRate: 0.7,
          costSavedMicros: 1_000,
          evictions: 0,
          items: null,
          indexBytes: null,
          threshold: null,
          extra: null,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getAiCacheHistory({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },

  otel_spans: {
    seed: async (storage, times) => {
      await storage.saveOtelSpans(
        ages(times).map((ingestedAt, index) => ({
          traceId: OTEL_TRACE_IDS[index],
          spanId: `${index + 1}`.padStart(16, '0'),
          parentSpanId: null,
          name: 'cache.lookup',
          scopeName: '@betterdb/semantic-cache',
          serviceName: 'app',
          kind: 1,
          // Both spans carry the same sender-supplied start time, so only the ingest time
          // the sweep keys on can tell them apart.
          startTimeUnixNano: `${times.recentAtMs}000000`,
          endTimeUnixNano: `${times.recentAtMs + 1}000000`,
          startTimeMs: times.recentAtMs,
          durationNs: 1_000_000,
          statusCode: 1,
          statusMessage: null,
          attributes: '{}',
          ingestedAt,
        })),
      );
    },
    remainingAtMs: async (storage) => {
      const traces = await Promise.all(
        OTEL_TRACE_IDS.map((traceId) => storage.getOtelTraceSpans(traceId)),
      );
      return traces.flat().map((row) => row.ingestedAt);
    },
  },

  command_stats_samples: {
    seed: async (storage, times) => {
      await storage.saveCommandStatsSamples(
        ages(times).map((capturedAt) => ({
          command: COMMAND,
          callsTotal: 100,
          usecTotal: 5_000,
          usecPerCall: 50,
          rejectedCalls: 0,
          failedCalls: 0,
          callsDelta: 10,
          usecDelta: 500,
          intervalMs: MINUTE_MS,
          capturedAt,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (
        await storage.getCommandStatsHistory({
          connectionId: CONNECTION_ID,
          command: COMMAND,
          ...ALL_TIME,
        })
      ).map((row) => row.capturedAt),
  },

  latency_stats_samples: {
    seed: async (storage, times) => {
      await storage.saveLatencyStatsSamples(
        ages(times).map((capturedAt) => ({
          command: COMMAND,
          p50Us: 10,
          p99Us: 100,
          p999Us: 500,
          serverVersion: '8.1.0',
          capturedAt,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getLatencyStatsHistory({ connectionId: CONNECTION_ID, ...ALL_TIME })).map(
        (row) => row.capturedAt,
      ),
  },

  replication_divergence_windows: {
    seed: async (storage, times) => {
      await storage.saveReplicationDivergenceWindows(
        ages(times).map((windowEnd) => ({
          replicaAddr: '10.0.0.2:6379',
          windowStart: windowEnd - MINUTE_MS,
          windowEnd,
          gapBytes: 1_024,
          bytesPerSec: 100,
          secondsBehind: 10,
          replicaGapBytes: null,
          replicaView: null,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (
        await storage.getReplicationDivergenceWindows({ connectionId: CONNECTION_ID, ...ALL_TIME })
      ).map((row) => row.windowEnd),
  },

  vector_index_snapshots: {
    seed: async (storage, times) => {
      await storage.saveVectorIndexSnapshots(
        ages(times).map((timestamp) => ({
          id: randomUUID(),
          timestamp,
          connectionId: CONNECTION_ID,
          indexName: 'idx:docs',
          numDocs: 100,
          numRecords: 100,
          numDeletedDocs: 0,
          indexingFailures: 0,
          indexingFailuresDelta: 0,
          percentIndexed: 1,
          indexingState: 'indexed',
          totalIndexingTime: 10,
          memorySizeMb: 1.5,
        })),
        CONNECTION_ID,
      );
    },
    remainingAtMs: async (storage) =>
      (await storage.getVectorIndexSnapshots({ connectionId: CONNECTION_ID })).map(
        (row) => row.timestamp,
      ),
  },
};
