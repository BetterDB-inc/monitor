import type { Incompatibility } from '@betterdb/shared';
import type { DatabaseCapabilities } from '../../common/interfaces/database-port.interface';

export interface InstanceMeta {
  dbType: 'valkey' | 'redis';
  version: string;
  capabilities: DatabaseCapabilities;
  clusterEnabled: boolean;
  databases: number[];
  modules: string[];
  maxmemoryPolicy: string;
  hasAclUsers: boolean;
  persistenceMode: string;
}

/**
 * Compare two semver strings: returns true if a >= b.
 * Handles versions like "8.1.0", "7.2.4", etc.
 */
function semverGte(a: string, b: string): boolean {
  const partsA = a.split('.').map(s => parseInt(s, 10) || 0);
  const partsB = b.split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true; // equal
}

export function buildInstanceMeta(
  info: Record<string, unknown>,
  capabilities: DatabaseCapabilities,
  aclUsers: string[],
): InstanceMeta {
  // clusterEnabled
  const clusterEnabled = String(info['cluster_enabled'] ?? '0') === '1';

  // databases: parse keys like 'db0', 'db1', etc.
  const databases: number[] = [];
  for (const key of Object.keys(info)) {
    const match = key.match(/^db(\d+)$/);
    if (match && typeof info[key] === 'string') {
      databases.push(parseInt(match[1], 10));
    }
  }
  if (databases.length === 0) {
    databases.push(0);
  }

  // modules: will be populated by caller via client.call('MODULE', 'LIST')
  // For now, default to empty — the caller sets this after construction if needed
  const modules: string[] = [];

  // maxmemoryPolicy
  const maxmemoryPolicy = (info['maxmemory_policy'] as string) ?? 'noeviction';

  // hasAclUsers: more than just the 'default' user
  const hasAclUsers = aclUsers.length > 1;

  // persistenceMode
  let hasRdb = false;
  let hasAof = false;

  const rdbLastSaveTime = Number(info['rdb_last_save_time'] ?? 0);
  if (rdbLastSaveTime > 0) {
    hasRdb = true;
  }

  const aofEnabled = String(info['aof_enabled'] ?? '0');
  if (aofEnabled === '1') {
    hasAof = true;
  }

  let persistenceMode: string;
  if (hasRdb && hasAof) {
    persistenceMode = 'rdb+aof';
  } else if (hasRdb) {
    persistenceMode = 'rdb';
  } else if (hasAof) {
    persistenceMode = 'aof';
  } else {
    persistenceMode = 'none';
  }

  return {
    dbType: capabilities.dbType,
    version: capabilities.version,
    capabilities,
    clusterEnabled,
    databases,
    modules,
    maxmemoryPolicy,
    hasAclUsers,
    persistenceMode,
  };
}

export function checkCompatibility(
  source: InstanceMeta,
  target: InstanceMeta,
  hfeDetected: boolean,
): Incompatibility[] {
  const issues: Incompatibility[] = [];

  // 1. Valkey -> Redis direction
  if (source.dbType === 'valkey' && target.dbType === 'redis') {
    issues.push({
      severity: 'blocking',
      category: 'type_direction',
      title: 'Valkey \u2192 Redis migration',
      detail:
        'Migrating from Valkey to Redis may lose Valkey-specific features and data structures. This direction is not recommended.',
    });
  }

  // 2. HFE unsupported on target
  if (hfeDetected) {
    const targetSupportsHfe =
      target.dbType === 'valkey' && semverGte(target.version, '8.1.0');
    if (!targetSupportsHfe) {
      issues.push({
        severity: 'blocking',
        category: 'hfe',
        title: 'Hash Field Expiry unsupported',
        detail:
          'Source uses Hash Field Expiry (HFE). Target does not support HFE \u2014 per-field TTLs will be lost during migration. Requires Valkey 8.1+.',
      });
    }
  }

  // 3. Missing modules
  for (const mod of source.modules) {
    if (!target.modules.includes(mod)) {
      issues.push({
        severity: 'blocking',
        category: 'modules',
        title: `Missing module: ${mod}`,
        detail: `Source uses the '${mod}' module which is not loaded on the target instance.`,
      });
    }
  }

  // 4. Cluster -> standalone mismatch
  if (source.clusterEnabled && !target.clusterEnabled) {
    issues.push({
      severity: 'blocking',
      category: 'cluster_topology',
      title: 'Cluster \u2192 standalone mismatch',
      detail:
        'Source runs in cluster mode but target is standalone. Data spread across multiple slots cannot be directly migrated to a single-node instance.',
    });
  }

  // 5. Standalone -> cluster migration
  if (!source.clusterEnabled && target.clusterEnabled) {
    issues.push({
      severity: 'warning',
      category: 'cluster_topology',
      title: 'Standalone \u2192 cluster migration',
      detail:
        'Source is standalone, target is clustered. Migration is possible but keys will be resharded across target slots.',
    });
  }

  // 6. Multi-DB to cluster unsupported
  if (source.databases.some(db => db !== 0) && target.clusterEnabled) {
    issues.push({
      severity: 'blocking',
      category: 'multi_db',
      title: 'Multi-DB to cluster unsupported',
      detail:
        'Source uses multiple databases (db indices beyond 0). Cluster mode only supports db0.',
    });
  }

  // 7. Multi-DB data may be lost (standalone target without matching DBs)
  if (
    source.databases.some(db => db !== 0) &&
    !target.clusterEnabled &&
    !target.databases.some(db => db !== 0)
  ) {
    issues.push({
      severity: 'warning',
      category: 'multi_db',
      title: 'Multi-DB data may be lost',
      detail:
        'Source uses databases beyond db0. Verify the target is configured to accept multiple databases.',
    });
  }

  // 8. Eviction policy mismatch
  if (source.maxmemoryPolicy !== target.maxmemoryPolicy) {
    issues.push({
      severity: 'warning',
      category: 'maxmemory_policy',
      title: 'Eviction policy mismatch',
      detail: `Source uses '${source.maxmemoryPolicy}', target uses '${target.maxmemoryPolicy}'. Mismatched eviction policies may cause unexpected key eviction after migration.`,
    });
  }

  // 9. ACL users not configured
  if (source.hasAclUsers && !target.hasAclUsers) {
    issues.push({
      severity: 'warning',
      category: 'acl',
      title: 'ACL users not configured',
      detail:
        'Source has custom ACL users configured. Target only has the default user. Recreate ACL rules on the target before migrating.',
    });
  }

  // 10. Persistence mode differs
  if (source.persistenceMode !== target.persistenceMode) {
    issues.push({
      severity: 'info',
      category: 'persistence',
      title: 'Persistence mode differs',
      detail: `Source uses '${source.persistenceMode}' persistence, target uses '${target.persistenceMode}'. Review target persistence settings to ensure durability requirements are met.`,
    });
  }

  return issues;
}
