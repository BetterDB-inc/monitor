import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Valkey from 'iovalkey';
import type { MigrationAnalysisRequest, MigrationAnalysisResult, StartAnalysisResponse, DataTypeBreakdown, DataTypeCount, TtlDistribution } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import type { AnalysisJob } from './analysis/analysis-job';
import { sampleKeyTypes } from './analysis/type-sampler';
import { sampleTtls } from './analysis/ttl-sampler';
import { detectHfe } from './analysis/hfe-detector';
import { analyzeCommands } from './analysis/commandlog-analyzer';
import { buildInstanceMeta, checkCompatibility } from './analysis/compatibility-checker';

@Injectable()
export class MigrationService {
  private readonly logger = new Logger(MigrationService.name);
  private jobs = new Map<string, AnalysisJob>();
  private readonly MAX_JOBS = 20;
  private readonly STUCK_JOB_TTL_MS = 30 * 60 * 1000;

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  async startAnalysis(req: MigrationAnalysisRequest): Promise<StartAnalysisResponse> {
    // Verify both connections exist before creating job (get() throws NotFoundException if not found)
    this.connectionRegistry.get(req.sourceConnectionId);
    this.connectionRegistry.get(req.targetConnectionId);

    this.evictOldJobs();

    const id = randomUUID();
    const job: AnalysisJob = {
      id,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      result: { id, status: 'pending', progress: 0, createdAt: Date.now() },
      cancelled: false,
      nodeClients: [],
    };

    this.jobs.set(id, job);

    // Fire and forget — do not await
    this.runAnalysis(job, req).catch(err => {
      this.logger.error(`Analysis ${id} failed: ${err.message}`);
    });

    return { id, status: 'pending' };
  }

  getJob(id: string): MigrationAnalysisResult | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (this.isJobStuck(job)) {
      this.jobs.delete(id);
      return undefined;
    }
    return {
      ...job.result,
      id: job.id,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
    } as MigrationAnalysisResult;
  }

  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.cancelled = true;
    job.status = 'cancelled';
    // Immediately quit all temporary node clients
    for (const client of job.nodeClients) {
      client.quit().catch(() => {});
    }
    job.nodeClients = [];
    return true;
  }

  private async runAnalysis(job: AnalysisJob, req: MigrationAnalysisRequest): Promise<void> {
    const scanSampleSize = req.scanSampleSize ?? 10_000;
    const tempClients: Valkey[] = [];

    try {
      job.status = 'running';
      job.progress = 5;

      // Step 1: Resolve source connection
      const adapter = this.connectionRegistry.get(req.sourceConnectionId);
      const config = this.connectionRegistry.getConfig(req.sourceConnectionId);
      const capabilities = adapter.getCapabilities();

      job.result.sourceConnectionId = req.sourceConnectionId;
      job.result.sourceConnectionName = config?.name;
      job.result.sourceDbType = capabilities.dbType;
      job.result.sourceDbVersion = capabilities.version;

      if (job.cancelled) return;
      job.progress = 10;

      // Step 2: Get source server info (keyspace for total key count, memory)
      const info = await adapter.getInfo(['keyspace', 'memory', 'cluster', 'server', 'persistence']);
      const keyspaceInfo = info as Record<string, unknown>;

      // Parse total keys from keyspace info
      let totalKeys = 0;
      for (const [key, val] of Object.entries(keyspaceInfo)) {
        if (key.startsWith('db') && typeof val === 'string') {
          const match = val.match(/keys=(\d+)/);
          if (match) totalKeys += parseInt(match[1], 10);
        }
      }
      job.result.totalKeys = totalKeys;

      // Parse used_memory
      const usedMemory = Number(keyspaceInfo['used_memory']) || 0;
      job.result.totalMemoryBytes = usedMemory;

      if (job.cancelled) return;
      job.progress = 12;

      // Step 2b: Read target info
      if (job.cancelled) return;

      const targetAdapter = this.connectionRegistry.get(req.targetConnectionId);
      const targetConfig = this.connectionRegistry.getConfig(req.targetConnectionId);
      const targetInfo = await targetAdapter.getInfo(['server', 'keyspace', 'cluster', 'memory', 'persistence']);
      const targetCapabilities = targetAdapter.getCapabilities();

      let targetAclUsers: string[] = [];
      try {
        const client = targetAdapter.getClient();
        const result = await client.call('ACL', 'USERS') as string[];
        targetAclUsers = result ?? [];
      } catch { /* ignore - ACL not supported or no permission */ }

      job.result.targetConnectionId = req.targetConnectionId;
      job.result.targetConnectionName = targetConfig?.name;
      job.result.targetDbType = targetCapabilities.dbType;
      job.result.targetDbVersion = targetCapabilities.version;
      job.result.targetIsCluster = String((targetInfo as Record<string, unknown>)['cluster_enabled'] ?? '0') === '1';

      if (job.cancelled) return;
      job.progress = 13;

      // Step 3: Cluster check (source)
      let isCluster = false;
      let clusterMasterCount = 0;
      const scanClients: Valkey[] = [];

      const clusterEnabled = String(keyspaceInfo['cluster_enabled'] ?? '0');
      if (clusterEnabled === '1') {
        isCluster = true;
        const nodes = await adapter.getClusterNodes();
        const masters = nodes.filter(n => n.flags.includes('master'));
        clusterMasterCount = masters.length;

        for (const master of masters) {
          // Parse address: 'host:port@clusterport'
          const addrPart = master.address?.split('@')[0] ?? '';
          const [host, portStr] = addrPart.split(':');
          const port = parseInt(portStr, 10);
          if (!host || isNaN(port)) continue;

          const client = new Valkey({
            host,
            port,
            username: config?.username || undefined,
            password: config?.password || undefined,
            tls: config?.tls ? {} : undefined,
            lazyConnect: true,
            connectionName: 'BetterDB-Migration-Analysis',
          });
          await client.connect();
          tempClients.push(client);
          job.nodeClients.push(client);
          scanClients.push(client);
        }
      } else {
        scanClients.push(adapter.getClient());
      }

      job.result.isCluster = isCluster;
      job.result.clusterMasterCount = clusterMasterCount;
      job.result.sampledPerNode = scanSampleSize;

      if (job.cancelled) return;
      job.progress = 15;

      // Step 4: Type sampling (SCAN + TYPE)
      const sampledKeys = await sampleKeyTypes(
        scanClients,
        scanSampleSize,
        (scanned) => {
          const progressRange = 50 - 15; // 15-50%
          const totalExpected = scanSampleSize * scanClients.length;
          const fraction = Math.min(scanned / totalExpected, 1);
          job.progress = Math.round(15 + fraction * progressRange);
        },
      );

      job.result.sampledKeys = sampledKeys.length;

      if (job.cancelled) return;
      job.progress = 50;

      // Step 5: Memory sampling (per-node to avoid cross-slot errors in cluster mode)
      const keysByClientIndex = new Map<number, typeof sampledKeys>();
      for (const sk of sampledKeys) {
        const group = keysByClientIndex.get(sk.clientIndex) ?? [];
        group.push(sk);
        keysByClientIndex.set(sk.clientIndex, group);
      }

      const memoryByType = new Map<string, { count: number; bytes: number }>();
      let memoryProcessed = 0;

      for (const [clientIndex, clientKeys] of keysByClientIndex) {
        const client = scanClients[clientIndex];
        for (let i = 0; i < clientKeys.length; i += 1000) {
          if (job.cancelled) return;
          const batch = clientKeys.slice(i, i + 1000);
          const pipeline = client.pipeline();
          for (const { key } of batch) {
            pipeline.call('MEMORY', 'USAGE', key, 'SAMPLES', '0');
          }
          const results = await pipeline.exec();
          if (results) {
            for (let j = 0; j < batch.length; j++) {
              const [err, mem] = results[j] ?? [];
              const bytes = err ? 0 : Number(mem) || 0;
              const t = batch[j].type;
              const entry = memoryByType.get(t) ?? { count: 0, bytes: 0 };
              entry.count++;
              entry.bytes += bytes;
              memoryByType.set(t, entry);
            }
          }
          memoryProcessed += batch.length;
          job.progress = Math.round(50 + (memoryProcessed / sampledKeys.length) * 15);
        }
      }

      // Build DataTypeBreakdown
      const knownTypes = new Set(['string', 'hash', 'list', 'set', 'zset', 'stream']);
      let otherCount = 0;
      let otherBytes = 0;

      for (const [typeName, data] of memoryByType) {
        if (!knownTypes.has(typeName)) {
          otherCount += data.count;
          otherBytes += data.bytes;
        }
      }

      const buildDtc = (typeName: string): DataTypeCount => {
        const data = memoryByType.get(typeName);
        if (!data) return { count: 0, sampledMemoryBytes: 0, estimatedTotalMemoryBytes: 0 };
        return {
          count: data.count,
          sampledMemoryBytes: data.bytes,
          estimatedTotalMemoryBytes: sampledKeys.length > 0
            ? Math.round((data.bytes / sampledKeys.length) * totalKeys)
            : 0,
        };
      };

      const breakdown: DataTypeBreakdown = {
        string: buildDtc('string'),
        hash: buildDtc('hash'),
        list: buildDtc('list'),
        set: buildDtc('set'),
        zset: buildDtc('zset'),
        stream: buildDtc('stream'),
        other: {
          count: otherCount,
          sampledMemoryBytes: otherBytes,
          estimatedTotalMemoryBytes: sampledKeys.length > 0
            ? Math.round((otherBytes / sampledKeys.length) * totalKeys)
            : 0,
        },
      };

      job.result.dataTypeBreakdown = breakdown;

      // Compute estimated total memory
      const totalSampledBytes = Array.from(memoryByType.values()).reduce((s, d) => s + d.bytes, 0);
      job.result.estimatedTotalMemoryBytes = sampledKeys.length > 0
        ? Math.round((totalSampledBytes / sampledKeys.length) * totalKeys)
        : 0;

      if (job.cancelled) return;
      job.progress = 65;

      // Step 6: TTL distribution (per-node)
      const mergedTtl: TtlDistribution = {
        noExpiry: 0, expiresWithin1h: 0, expiresWithin24h: 0,
        expiresWithin7d: 0, expiresAfter7d: 0, sampledKeyCount: sampledKeys.length,
      };
      for (const [clientIndex, clientKeys] of keysByClientIndex) {
        const nodeTtl = await sampleTtls(scanClients[clientIndex], clientKeys.map(k => k.key));
        mergedTtl.noExpiry += nodeTtl.noExpiry;
        mergedTtl.expiresWithin1h += nodeTtl.expiresWithin1h;
        mergedTtl.expiresWithin24h += nodeTtl.expiresWithin24h;
        mergedTtl.expiresWithin7d += nodeTtl.expiresWithin7d;
        mergedTtl.expiresAfter7d += nodeTtl.expiresAfter7d;
      }
      job.result.ttlDistribution = mergedTtl;

      if (job.cancelled) return;
      job.progress = 75;

      // Step 7: HFE detection (per-node)
      if (capabilities.dbType === 'valkey') {
        const hashKeys = sampledKeys.filter(k => k.type === 'hash');
        const totalEstimatedHashKeys = totalKeys > 0 && sampledKeys.length > 0
          ? Math.round((hashKeys.length / sampledKeys.length) * totalKeys)
          : hashKeys.length;

        // Group hash keys by originating client
        const hashByClient = new Map<number, string[]>();
        for (const hk of hashKeys) {
          const group = hashByClient.get(hk.clientIndex) ?? [];
          group.push(hk.key);
          hashByClient.set(hk.clientIndex, group);
        }

        let hfeDetected = false;
        let hfeSupported = true;
        let hfeKeyCount = 0;
        let hfeOversizedHashesSkipped = 0;

        for (const [clientIndex, nodeHashKeys] of hashByClient) {
          // Each node's estimated share of total hash keys
          const nodeEstimatedTotal = hashKeys.length > 0
            ? Math.round((nodeHashKeys.length / hashKeys.length) * totalEstimatedHashKeys)
            : 0;
          const hfeResult = await detectHfe(scanClients[clientIndex], nodeHashKeys, nodeEstimatedTotal);
          if (!hfeResult.hfeSupported) hfeSupported = false;
          if (hfeResult.hfeDetected) hfeDetected = true;
          hfeKeyCount += hfeResult.hfeKeyCount;
          hfeOversizedHashesSkipped += hfeResult.hfeOversizedHashesSkipped;
        }

        job.result.hfeDetected = hfeDetected;
        job.result.hfeSupported = hfeSupported;
        job.result.hfeKeyCount = hfeKeyCount;
        job.result.hfeOversizedHashesSkipped = hfeOversizedHashesSkipped;
      } else {
        job.result.hfeSupported = false;
        job.result.hfeDetected = false;
      }

      if (job.cancelled) return;
      job.progress = 85;

      // Step 8: Command analysis
      job.result.commandAnalysis = await analyzeCommands(adapter);

      if (job.cancelled) return;
      job.progress = 90;

      // Step 9: Compatibility checking
      // Fetch source ACL users
      let sourceAclUsers: string[] = [];
      try {
        const sourceClient = adapter.getClient();
        const result = await sourceClient.call('ACL', 'USERS') as string[];
        sourceAclUsers = result ?? [];
      } catch { /* ignore - ACL not supported or no permission */ }

      // Build source meta
      const sourceMeta = buildInstanceMeta(keyspaceInfo, capabilities, sourceAclUsers);

      // Fetch source modules
      try {
        const sourceClient = adapter.getClient();
        const moduleResult = await sourceClient.call('MODULE', 'LIST') as unknown[];
        sourceMeta.modules = parseModuleList(moduleResult);
      } catch { /* ignore */ }

      // Build target meta
      const targetMeta = buildInstanceMeta(targetInfo as Record<string, unknown>, targetCapabilities, targetAclUsers);

      // Fetch target modules
      try {
        const targetClient = targetAdapter.getClient();
        const moduleResult = await targetClient.call('MODULE', 'LIST') as unknown[];
        targetMeta.modules = parseModuleList(moduleResult);
      } catch { /* ignore */ }

      const incompatibilities = checkCompatibility(sourceMeta, targetMeta, job.result.hfeDetected ?? false);
      job.result.incompatibilities = incompatibilities;
      job.result.blockingCount = incompatibilities.filter(i => i.severity === 'blocking').length;
      job.result.warningCount = incompatibilities.filter(i => i.severity === 'warning').length;

      if (job.cancelled) return;
      job.progress = 95;

      // Done
      job.progress = 100;
      job.status = 'completed';
      job.completedAt = Date.now();
      job.result.status = 'completed';
      job.result.completedAt = job.completedAt;

      this.logger.log(`Analysis ${job.id} completed: blocking=${job.result.blockingCount}, warnings=${job.result.warningCount}, sampledKeys=${sampledKeys.length}, totalKeys=${totalKeys}`);

    } catch (err: unknown) {
      if (!job.cancelled) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = message;
        job.result.status = 'failed';
        job.result.error = job.error;
        job.completedAt = Date.now();
        this.logger.error(`Analysis ${job.id} failed: ${job.error}`);
      }
    } finally {
      // Only quit temporary per-node clients, never the adapter's client
      await Promise.allSettled(tempClients.map(c => c.quit()));
      job.nodeClients = [];
    }
  }

  private evictOldJobs(): void {
    if (this.jobs.size < this.MAX_JOBS) return;

    // First: evict stuck running jobs
    for (const [id, job] of this.jobs) {
      if (this.isJobStuck(job)) {
        this.jobs.delete(id);
      }
    }

    // Then: evict oldest completed/failed/cancelled
    if (this.jobs.size >= this.MAX_JOBS) {
      const terminal = Array.from(this.jobs.entries())
        .filter(([, j]) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
        .sort((a, b) => a[1].createdAt - b[1].createdAt);

      for (const [id] of terminal) {
        if (this.jobs.size < this.MAX_JOBS) break;
        this.jobs.delete(id);
      }
    }
  }

  private isJobStuck(job: AnalysisJob): boolean {
    return job.status === 'running' && Date.now() - job.createdAt > this.STUCK_JOB_TTL_MS;
  }
}

/**
 * Parse the result of MODULE LIST command.
 * The result is typically an array of arrays, where each inner element
 * contains name/value pairs like: [['name', 'modulename', 'ver', 1, ...], ...]
 * or in newer versions: [[name, modulename, ver, 1], ...]
 */
function parseModuleList(result: unknown[]): string[] {
  if (!Array.isArray(result)) return [];
  const modules: string[] = [];
  for (const entry of result) {
    if (Array.isArray(entry)) {
      // Find the 'name' key and take the next element as the value
      for (let i = 0; i < entry.length - 1; i++) {
        if (String(entry[i]).toLowerCase() === 'name') {
          modules.push(String(entry[i + 1]));
          break;
        }
      }
    }
  }
  return modules;
}
