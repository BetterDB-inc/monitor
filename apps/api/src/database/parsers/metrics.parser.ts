import {
  InfoResponse,
  KeyspaceDbInfo,
  SlowLogEntry,
  CommandLogEntry,
  CommandLogType,
  ClientInfo,
  AclLogEntry,
  ClusterNode,
  ClusterShard,
  ClusterShardNode,
  SlotStats,
  SentinelNodeInfo,
} from '../../common/types/metrics.types';
import { InfoParser } from './info.parser';
import { toNumber } from '../../metrics/commandstats-parser';

/**
 * Matches per-database keyspace keys (db0, db1, ...). Single definition of
 * "what counts as a db entry" — consumers rely on parseInfoToTyped emitting
 * typed objects for exactly these keys.
 */
export const KEYSPACE_DB_KEY = /^db\d+$/;

export class MetricsParser {
  static parseInfoToTyped(info: Record<string, unknown>): InfoResponse {
    const result: Record<string, unknown> = { ...info };

    if (info.keyspace) {
      result.keyspace = this.parseKvSection(
        info.keyspace,
        (key) => KEYSPACE_DB_KEY.test(key),
        (fields) => {
          const keys = Number(fields.keys);
          // A db line without a numeric keys field is unparseable — keep the
          // raw string so malformed input stays distinguishable from an empty
          // database instead of masquerading as keys:0.
          if (!Number.isFinite(keys)) return null;
          const entry: KeyspaceDbInfo = {
            keys,
            expires: toNumber(fields.expires),
            avg_ttl: toNumber(fields.avg_ttl),
          };
          // Preserve additional numeric fields (e.g. subexpiry on Redis 7.4+).
          for (const [field, value] of Object.entries(fields)) {
            if (field in entry) continue;
            const n = Number(value);
            if (Number.isFinite(n)) entry[field] = n;
          }
          return entry;
        },
      );
    }

    if (info.commandstats) {
      result.commandstats = this.parseKvSection(
        info.commandstats,
        (key) => key.startsWith('cmdstat_'),
        (fields) => {
          const calls = Number(fields.calls);
          if (!Number.isFinite(calls)) return null;
          const stat: {
            calls: number;
            usec: number;
            usec_per_call: number;
            rejected_calls?: number;
            failed_calls?: number;
          } = {
            calls,
            usec: toNumber(fields.usec),
            usec_per_call: toNumber(fields.usec_per_call),
          };
          if (fields.rejected_calls !== undefined)
            stat.rejected_calls = toNumber(fields.rejected_calls);
          if (fields.failed_calls !== undefined) stat.failed_calls = toNumber(fields.failed_calls);
          return stat;
        },
      );
    }

    if (info.errorstats) {
      result.errorstats = this.parseKvSection(
        info.errorstats,
        (key) => key.startsWith('errorstat_'),
        (fields) => {
          const count = Number(fields.count);
          return Number.isFinite(count) ? { count } : null;
        },
      );
    }

    return result as InfoResponse;
  }

  /**
   * Converts a section's "k=v,k=v" string values (as produced by
   * InfoParser.parse) into typed objects. Entries whose key doesn't match,
   * whose value isn't a string, or that toTyped rejects (returns null) are
   * passed through untouched, so the transform is idempotent and malformed
   * lines survive as raw strings.
   */
  private static parseKvSection(
    section: unknown,
    keyMatches: (key: string) => boolean,
    toTyped: (fields: Record<string, string>) => unknown | null,
  ): unknown {
    if (!section || typeof section !== 'object') return section;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(section as Record<string, unknown>)) {
      // Assigning this key would hit the Object.prototype setter instead of
      // creating an own property.
      if (key === '__proto__') continue;
      out[key] =
        keyMatches(key) && typeof val === 'string'
          ? (toTyped(InfoParser.parseKvLine(val, ',')) ?? val)
          : val;
    }
    return out;
  }

  static parseSlowLog(rawEntries: unknown[]): SlowLogEntry[] {
    return rawEntries.map((entry) => {
      const arr = entry as unknown[];
      return {
        id: arr[0] as number,
        timestamp: arr[1] as number,
        duration: arr[2] as number,
        command: arr[3] as string[],
        clientAddress: arr[4] as string,
        clientName: arr[5] as string,
      };
    });
  }

  static parseCommandLog(rawEntries: unknown[]): CommandLogEntry[] {
    return rawEntries.map((entry) => {
      const arr = entry as unknown[];
      return {
        id: arr[0] as number,
        timestamp: arr[1] as number,
        duration: arr[2] as number,
        command: arr[3] as string[],
        clientAddress: arr[4] as string,
        clientName: arr[5] as string,
        type: arr[6] as CommandLogType,
      };
    });
  }

  static parseClientList(clientListString: string): ClientInfo[] {
    const lines = clientListString.trim().split('\n');
    return lines.map((line) => {
      const client: ClientInfo = {
        id: '',
        addr: '',
        name: '',
        age: 0,
        idle: 0,
        flags: '',
        db: 0,
        sub: 0,
        psub: 0,
        multi: 0,
        qbuf: 0,
        qbufFree: 0,
        obl: 0,
        oll: 0,
        omem: 0,
        events: '',
        cmd: '',
        user: '',
      };

      const fields = InfoParser.parseKvLine(line, ' ');
      for (const [key, value] of Object.entries(fields)) {
        switch (key) {
          case 'id':
            client.id = value;
            break;
          case 'addr':
            client.addr = value;
            break;
          case 'name':
            client.name = value;
            break;
          case 'age':
            client.age = parseInt(value, 10);
            break;
          case 'idle':
            client.idle = parseInt(value, 10);
            break;
          case 'flags':
            client.flags = value;
            break;
          case 'db':
            client.db = parseInt(value, 10);
            break;
          case 'sub':
            client.sub = parseInt(value, 10);
            break;
          case 'psub':
            client.psub = parseInt(value, 10);
            break;
          case 'multi':
            client.multi = parseInt(value, 10);
            break;
          case 'qbuf':
            client.qbuf = parseInt(value, 10);
            break;
          case 'qbuf-free':
            client.qbufFree = parseInt(value, 10);
            break;
          case 'obl':
            client.obl = parseInt(value, 10);
            break;
          case 'oll':
            client.oll = parseInt(value, 10);
            break;
          case 'omem':
            client.omem = parseInt(value, 10);
            break;
          case 'events':
            client.events = value;
            break;
          case 'cmd':
            client.cmd = value;
            break;
          case 'user':
            client.user = value;
            break;
          default:
            client[key] = value;
        }
      }

      return client;
    });
  }

  static parseAclLog(rawEntries: unknown[]): AclLogEntry[] {
    return rawEntries.map((entry) => {
      // ACL LOG returns flat arrays like ["count", 1, "reason", "auth", ...]
      // Convert to object first
      const arr = entry as unknown[];
      const obj: Record<string, unknown> = {};

      for (let i = 0; i < arr.length; i += 2) {
        const key = arr[i] as string;
        const value = arr[i + 1];
        if (key && value !== undefined) {
          obj[key] = value;
        }
      }

      return {
        count: obj['count'] as number,
        reason: obj['reason'] as string,
        context: obj['context'] as string,
        object: obj['object'] as string,
        username: obj['username'] as string,
        ageSeconds: parseFloat(obj['age-seconds'] as string),
        clientInfo: obj['client-info'] as string,
        timestampCreated: obj['timestamp-created'] as number,
        timestampLastUpdated: obj['timestamp-last-updated'] as number,
      };
    });
  }

  static parseClusterNodes(nodesString: string): ClusterNode[] {
    const lines = nodesString.trim().split('\n');
    return lines.map((line) => {
      const parts = line.split(' ');
      // The address field is `ip:port@cport` with an optional `,hostname`
      // suffix (valkey-io/valkey#304): `ip:port@cport[,hostname]`. The
      // hostname segment is empty when the node has no announced hostname
      // yet. Split it off so `address` stays exactly `ip:port@cport` for
      // every existing caller, and surface the hostname separately.
      const addressField = parts[1] || '';
      const commaIdx = addressField.indexOf(',');
      const address = commaIdx === -1 ? addressField : addressField.slice(0, commaIdx);
      const hostname = commaIdx === -1 ? '' : addressField.slice(commaIdx + 1);

      const node: ClusterNode = {
        id: parts[0] || '',
        address,
        flags: (parts[2] || '').split(','),
        master: parts[3] || '',
        pingSent: parseInt(parts[4] || '0', 10),
        pongReceived: parseInt(parts[5] || '0', 10),
        configEpoch: parseInt(parts[6] || '0', 10),
        linkState: parts[7] || '',
        slots: [],
        migratingSlots: [],
        importingSlots: [],
      };
      if (hostname) node.hostname = hostname;

      for (let i = 8; i < parts.length; i++) {
        const slotPart = parts[i];
        if (!slotPart) continue;

        const migratingMatch = slotPart.match(/\[(\d+)->-([a-f0-9]+)\]/i);
        if (migratingMatch) {
          const slot = parseInt(migratingMatch[1], 10);
          const targetNodeId = migratingMatch[2];
          node.migratingSlots?.push({ slot, targetNodeId });
          continue;
        }

        const importingMatch = slotPart.match(/\[(\d+)-<-([a-f0-9]+)\]/i);
        if (importingMatch) {
          const slot = parseInt(importingMatch[1], 10);
          const sourceNodeId = importingMatch[2];
          node.importingSlots?.push({ slot, sourceNodeId });
          continue;
        }

        if (slotPart.includes('-')) {
          const [start, end] = slotPart.split('-').map((s) => parseInt(s, 10));
          if (!isNaN(start) && !isNaN(end)) {
            node.slots.push([start, end]);
          }
        } else {
          const slotNum = parseInt(slotPart, 10);
          if (!isNaN(slotNum)) {
            node.slots.push([slotNum, slotNum]);
          }
        }
      }

      if (node.migratingSlots?.length === 0) delete node.migratingSlots;
      if (node.importingSlots?.length === 0) delete node.importingSlots;

      return node;
    });
  }

  /**
   * Coerce a RESP map reply into a `Map<string, unknown>`. iovalkey returns map
   * replies as a flat `[key, value, key, value, ...]` array under RESP2 and as a
   * plain object under RESP3, so handle both shapes.
   */
  private static flatReplyToMap(entry: unknown): Map<string, unknown> | null {
    if (Array.isArray(entry)) {
      const map = new Map<string, unknown>();
      for (let i = 0; i + 1 < entry.length; i += 2) {
        const key = entry[i];
        if (typeof key === 'string') map.set(key, entry[i + 1]);
      }
      return map;
    }
    // RESP3 returns map-typed replies as a JS Map, not a flat array or plain
    // object — Object.entries(Map) is [] and would silently yield empty shards,
    // disabling Layer 2. Read the Map's string entries directly.
    if (entry instanceof Map) {
      const map = new Map<string, unknown>();
      for (const [key, value] of entry) {
        if (typeof key === 'string') map.set(key, value);
      }
      return map;
    }
    if (entry && typeof entry === 'object') {
      return new Map(Object.entries(entry as Record<string, unknown>));
    }
    return null;
  }

  /**
   * Parse a `CLUSTER SHARDS` reply into `ClusterShard[]`. The reply is an array
   * of shards, each a map with `slots` (a flat `[start, end, start, end, ...]`
   * array) and `nodes` (an array of per-node maps carrying id/role/health/etc.).
   * Malformed or role-less entries are skipped defensively.
   */
  /**
   * Parses a `SENTINEL MASTERS` / `SENTINEL REPLICAS <master>` /
   * `SENTINEL SENTINELS <master>` reply: an array of flat field/value lists.
   *
   * Entries without a usable `ip` are dropped — an endpoint is the whole point
   * of this view, and a node we cannot address is not something the drift
   * detector can reason about.
   */
  static parseSentinelNodes(raw: unknown[]): SentinelNodeInfo[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const nodes: SentinelNodeInfo[] = [];
    for (const entry of raw) {
      const map = MetricsParser.flatReplyToMap(entry);
      if (!map) {
        continue;
      }

      const fields: Record<string, string> = {};
      for (const [key, value] of map) {
        if (typeof value === 'string' || typeof value === 'number') {
          fields[key] = String(value);
        }
      }

      const ip = fields['ip'];
      if (!ip) {
        continue;
      }

      const masterPort = Number(fields['master-port']);
      nodes.push({
        name: fields['name'] ?? '',
        ip,
        port: Number(fields['port']) || 0,
        runid: fields['runid'] ?? '',
        flags: (fields['flags'] ?? '')
          .split(',')
          .map((flag) => flag.trim())
          .filter(Boolean),
        masterHost: fields['master-host'],
        masterPort: isNaN(masterPort) ? undefined : masterPort,
        fields,
      });
    }

    return nodes;
  }

  static parseClusterShards(raw: unknown[]): ClusterShard[] {
    if (!Array.isArray(raw)) return [];
    const shards: ClusterShard[] = [];

    for (const shardEntry of raw) {
      const shardMap = MetricsParser.flatReplyToMap(shardEntry);
      if (!shardMap) continue;

      const slots: number[][] = [];
      const rawSlots = shardMap.get('slots');
      if (Array.isArray(rawSlots)) {
        for (let i = 0; i + 1 < rawSlots.length; i += 2) {
          const start = Number(rawSlots[i]);
          const end = Number(rawSlots[i + 1]);
          if (!isNaN(start) && !isNaN(end)) slots.push([start, end]);
        }
      }

      const nodes: ClusterShardNode[] = [];
      const rawNodes = shardMap.get('nodes');
      if (Array.isArray(rawNodes)) {
        for (const nodeEntry of rawNodes) {
          const nodeMap = MetricsParser.flatReplyToMap(nodeEntry);
          if (!nodeMap) continue;

          const id = nodeMap.get('id');
          if (typeof id !== 'string' || !id) continue;

          const role = nodeMap.get('role');
          const endpoint = nodeMap.get('endpoint') ?? nodeMap.get('ip');
          // Announced hostname (valkey#304) — present only when the node sets
          // cluster-announce-hostname; distinct from `endpoint`, which follows
          // cluster-preferred-endpoint-type (default `ip`).
          const hostname = nodeMap.get('hostname');
          const port = nodeMap.get('port') ?? nodeMap.get('tls-port');
          const replOffset = nodeMap.get('replication-offset');
          const health = nodeMap.get('health');

          nodes.push({
            id,
            role: typeof role === 'string' ? role : 'unknown',
            ...(typeof health === 'string' ? { health } : {}),
            ...(typeof endpoint === 'string' ? { endpoint } : {}),
            ...(typeof hostname === 'string' && hostname ? { hostname } : {}),
            ...(typeof port === 'number' ? { port } : {}),
            ...(typeof replOffset === 'number' ? { replicationOffset: replOffset } : {}),
          });
        }
      }

      shards.push({ slots, nodes });
    }

    return shards;
  }

  static parseSlotStats(rawStats: unknown[] | unknown[][]): SlotStats {
    const stats: SlotStats = {};

    if (rawStats.length === 0) {
      return stats;
    }

    // iovalkey transforms CLUSTER SLOT-STATS response into nested format:
    // [[slot, [metric_name, value]], [slot, [metric_name, value]], ...]
    if (!Array.isArray(rawStats[0])) {
      // If unexpected format, return empty stats
      return stats;
    }

    const nestedStats = rawStats as unknown[][];

    for (const entry of nestedStats) {
      if (!Array.isArray(entry) || entry.length < 2) continue;

      const slot = entry[0];
      const metricPair = entry[1];

      if (typeof slot !== 'number' || !Array.isArray(metricPair) || metricPair.length < 2) {
        continue;
      }

      const metricName = metricPair[0];
      const metricValue = metricPair[1];

      if (typeof metricName !== 'string' || typeof metricValue !== 'number') {
        continue;
      }

      const slotKey = slot.toString();
      if (!stats[slotKey]) {
        stats[slotKey] = {
          key_count: 0,
          expires_count: 0,
          total_reads: 0,
          total_writes: 0,
        };
      }

      switch (metricName.toLowerCase()) {
        case 'key-count':
          stats[slotKey].key_count = metricValue;
          break;
        case 'expires-count':
          stats[slotKey].expires_count = metricValue;
          break;
        case 'total-reads':
          stats[slotKey].total_reads = metricValue;
          break;
        case 'total-writes':
          stats[slotKey].total_writes = metricValue;
          break;
      }
    }

    return stats;
  }

  static parseMemoryStats(rawStats: Record<string, unknown>): Record<string, unknown> {
    return rawStats;
  }

  static parseConfigGet(configArray: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < configArray.length; i += 2) {
      const key = configArray[i];
      const value = configArray[i + 1];
      if (key && value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }
}
