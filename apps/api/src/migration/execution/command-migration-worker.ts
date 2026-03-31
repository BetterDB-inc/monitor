import Valkey from 'iovalkey';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import type { ExecutionJob } from './execution-job';
import { migrateKey } from './type-handlers';

const SCAN_COUNT = 500;
const TYPE_BATCH = 500;
const MIGRATE_BATCH = 50;

export interface CommandMigrationOptions {
  sourceConfig: DatabaseConnectionConfig;
  targetConfig: DatabaseConnectionConfig;
  sourceIsCluster: boolean;
  job: ExecutionJob;
  maxLogLines: number;
}

/**
 * Run a command-based migration: SCAN source → TYPE → type-specific read/write → TTL.
 * Operates entirely in-process using iovalkey. No external binary needed.
 */
export async function runCommandMigration(opts: CommandMigrationOptions): Promise<void> {
  const { sourceConfig, targetConfig, sourceIsCluster, job, maxLogLines } = opts;
  const sourceClients: Valkey[] = [];
  const targetClient = createClient(targetConfig, 'BetterDB-Migration-Target');

  try {
    await targetClient.connect();
    log(job, maxLogLines, 'Connected to target');

    // Build source clients (one per cluster master, or single standalone)
    if (sourceIsCluster) {
      const discoveryClient = createClient(sourceConfig, 'BetterDB-Migration-Discovery');
      await discoveryClient.connect();
      try {
        const nodesRaw = await discoveryClient.call('CLUSTER', 'NODES') as string;
        const masters = parseClusterMasters(nodesRaw);
        log(job, maxLogLines, `Cluster mode: ${masters.length} master(s) detected`);
        for (const { host, port } of masters) {
          const client = new Valkey({
            host,
            port,
            username: sourceConfig.username || undefined,
            password: sourceConfig.password || undefined,
            tls: sourceConfig.tls ? {} : undefined,
            lazyConnect: true,
            connectionName: 'BetterDB-Migration-Source',
          });
          await client.connect();
          sourceClients.push(client);
        }
      } finally {
        await discoveryClient.quit();
      }
    } else {
      const client = createClient(sourceConfig, 'BetterDB-Migration-Source');
      await client.connect();
      sourceClients.push(client);
    }

    log(job, maxLogLines, `Connected to source (${sourceClients.length} node(s))`);

    // Count total keys across all source nodes for progress tracking
    let totalKeys = 0;
    for (const client of sourceClients) {
      const dbsize = await client.dbsize();
      totalKeys += dbsize;
    }
    job.totalKeys = totalKeys;
    log(job, maxLogLines, `Total keys to migrate: ${totalKeys.toLocaleString()}`);

    if (totalKeys === 0) {
      log(job, maxLogLines, 'No keys to migrate');
      job.progress = 100;
      return;
    }

    // Scan and migrate each source node
    let keysProcessed = 0;
    let keysSkipped = 0;

    for (let nodeIdx = 0; nodeIdx < sourceClients.length; nodeIdx++) {
      const sourceClient = sourceClients[nodeIdx];
      if (isCancelled(job)) return;

      if (sourceClients.length > 1) {
        log(job, maxLogLines, `Scanning node ${nodeIdx + 1}/${sourceClients.length}...`);
      }

      let cursor = '0';
      do {
        if (isCancelled(job)) return;

        const [nextCursor, keys] = await sourceClient.scan(cursor, 'COUNT', SCAN_COUNT);
        cursor = nextCursor;

        if (keys.length === 0) continue;

        // Batch TYPE lookup
        const types = await batchType(sourceClient, keys);

        // Migrate keys in parallel batches for throughput
        for (let batchStart = 0; batchStart < keys.length; batchStart += MIGRATE_BATCH) {
          if (isCancelled(job)) return;

          const batchEnd = Math.min(batchStart + MIGRATE_BATCH, keys.length);
          const batchPromises: Promise<void>[] = [];

          for (let i = batchStart; i < batchEnd; i++) {
            const key = keys[i];
            const type = types[i];

            if (type === 'none') {
              // Key expired between SCAN and TYPE
              keysProcessed++;
              continue;
            }

            batchPromises.push(
              migrateKey(sourceClient, targetClient, key, type).then(result => {
                if (result.ok) {
                  job.keysTransferred++;
                } else {
                  keysSkipped++;
                  job.keysSkipped = keysSkipped;
                  log(job, maxLogLines, `SKIP ${key} (${type}): ${result.error}`);
                }
                keysProcessed++;
              }),
            );
          }

          await Promise.all(batchPromises);
          job.progress = Math.min(99, Math.round((keysProcessed / totalKeys) * 100));
        }

        // Periodic progress log
        if (keysProcessed % 5000 < keys.length) {
          log(job, maxLogLines,
            `Progress: ${keysProcessed.toLocaleString()}/${totalKeys.toLocaleString()} keys ` +
            `(${job.keysTransferred.toLocaleString()} transferred, ${keysSkipped} skipped)`);
        }
      } while (cursor !== '0');
    }

    job.progress = 100;
    log(job, maxLogLines,
      `Migration complete: ${job.keysTransferred.toLocaleString()} transferred, ${keysSkipped} skipped out of ${totalKeys.toLocaleString()} total`);

  } finally {
    await Promise.allSettled([...sourceClients, targetClient].map(c => c.quit()));
  }
}

// ── Helpers ──

function createClient(config: DatabaseConnectionConfig, name: string): Valkey {
  return new Valkey({
    host: config.host,
    port: config.port,
    username: config.username || undefined,
    password: config.password || undefined,
    tls: config.tls ? {} : undefined,
    lazyConnect: true,
    connectTimeout: 10_000,
    commandTimeout: 15_000,
    connectionName: name,
  });
}

function parseClusterMasters(nodesRaw: string): Array<{ host: string; port: number }> {
  const results: Array<{ host: string; port: number }> = [];
  for (const line of nodesRaw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    const flags = parts[2] ?? '';
    if (!flags.includes('master')) continue;
    // address format: host:port@clusterport (host may be IPv6, e.g. [::1]:6379@16379)
    const addrPart = (parts[1] ?? '').split('@')[0];
    const lastColon = addrPart.lastIndexOf(':');
    let host = lastColon > 0 ? addrPart.substring(0, lastColon) : '';
    const port = lastColon > 0 ? parseInt(addrPart.substring(lastColon + 1), 10) : NaN;
    // Strip IPv6 brackets — iovalkey expects bare addresses
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    if (host && !isNaN(port)) {
      results.push({ host, port });
    }
  }
  return results;
}

async function batchType(client: Valkey, keys: string[]): Promise<string[]> {
  const pipeline = client.pipeline();
  for (const key of keys) {
    pipeline.type(key);
  }
  const results = await pipeline.exec();
  return (results ?? []).map(([err, val]) => {
    if (err) return 'none';
    return String(val);
  });
}

function isCancelled(job: ExecutionJob): boolean {
  return (job.status as string) === 'cancelled';
}

function log(job: ExecutionJob, maxLines: number, message: string): void {
  const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const line = `[${timestamp}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > maxLines) {
    job.logs.shift();
  }
}
