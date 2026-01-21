import {
  InfoResponse,
  SlowLogEntry,
  CommandLogEntry,
  CommandLogType,
  ClientInfo,
  AclLogEntry,
  ClusterNode,
  SlotStats,
  SlotStatsMetric,
} from '../../common/types/metrics.types';

export class MetricsParser {
  static parseInfoToTyped(info: Record<string, unknown>): InfoResponse {
    return info as InfoResponse;
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

      const pairs = line.split(' ');
      for (const pair of pairs) {
        const [key, value] = pair.split('=');
        if (!key || value === undefined) continue;

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
      const node: ClusterNode = {
        id: parts[0] || '',
        address: parts[1] || '',
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

      switch (metricName) {
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
