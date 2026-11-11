import { appendFileSync } from 'node:fs';
import type { SimConfig } from '../config.js';
import { valkeyPods } from '../infra/verify.js';
import { BetterdbApi, type Connection } from './api.js';

export interface BetterdbRecord {
  kind: 'event' | 'group';
  firstSeenAt: number;
  connectionId: string | null;
  pod: string | null;
  shard: number | null;
  payload: unknown;
}

// Polls BetterDB's REST API during a run and appends deduped records to betterdb.jsonl.
// Events are fetched per connection (X-Connection-Id) because the per-node detectors
// run on each auto-registered child; groups are cluster-wide and re-emitted when they grow.
export function startBetterdbCollector(cfg: SimConfig, file: string, runStart: number) {
  const api = new BetterdbApi(cfg);
  const seenEvents = new Set<string>();
  const groupSizes = new Map<string, number>();
  let conns: Connection[] = [];
  let podByIp = new Map<string, { name: string; shard: number }>();
  let stopped = false;
  let errors = 0;

  const write = (r: BetterdbRecord) => appendFileSync(file, JSON.stringify(r) + '\n');
  const attribute = (connectionId: string | null | undefined) => {
    const c = conns.find((x) => x.id === connectionId);
    const pod = c ? podByIp.get(c.host) : undefined;
    return { connectionId: connectionId ?? null, pod: pod?.name ?? null, shard: pod?.shard ?? null };
  };

  async function tick() {
    const now = Date.now();
    conns = (await api.connections()).connections.filter((c) => !c.membership?.retiredAt);
    // Pod IPs change on failover/roll; refresh the map each tick.
    podByIp = new Map((await valkeyPods(cfg)).map((p) => [p.ip, { name: p.name, shard: p.shard }]));
    await Promise.all(conns.map(async (c) => {
      for (const e of await api.events(runStart, undefined, c.id)) {
        if (seenEvents.has(e.id)) continue;
        seenEvents.add(e.id);
        write({ kind: 'event', firstSeenAt: now, ...attribute(e.connectionId ?? c.id), payload: e });
      }
    }));
    for (const g of await api.groups(runStart)) {
      if (groupSizes.get(g.correlationId) === g.anomalies.length) continue;
      groupSizes.set(g.correlationId, g.anomalies.length);
      write({ kind: 'group', firstSeenAt: now, ...attribute(g.anomalies[0]?.connectionId), payload: g });
    }
  }

  const loop = (async () => {
    while (!stopped) {
      const t = Date.now();
      await tick().catch((e: Error) => {
        errors++;
        appendFileSync(file, JSON.stringify({ kind: 'collector_error', firstSeenAt: Date.now(), message: e.message.slice(0, 300) }) + '\n');
      });
      await new Promise((r) => setTimeout(r, Math.max(0, cfg.betterdb.pollSec * 1000 - (Date.now() - t))));
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
      // One last sweep so detections that land right at the end are kept.
      await tick().catch(() => undefined);
      return { events: seenEvents.size, groups: groupSizes.size, errors };
    },
  };
}
