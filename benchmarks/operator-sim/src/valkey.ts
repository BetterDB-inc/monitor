import { GlideClusterClient } from '@valkey/valkey-glide';
import type { SimConfig } from './config.js';

// In-cluster addressing: the operator's headless Service resolves to every pod.
export const headlessHost = (cfg: SimConfig) => `valkey-${cfg.cluster.name}.${cfg.cluster.namespace}.svc.cluster.local`;
export const VALKEY_PORT = 6379;

export function clusterClient(cfg: SimConfig, requestTimeout = cfg.clients.requestTimeoutMs) {
  return GlideClusterClient.createClient({
    addresses: [{ host: headlessHost(cfg), port: VALKEY_PORT }],
    requestTimeout,
    clientName: 'operator-sim',
  });
}

export interface ShardNode { id: string; ip: string; port: number; role: 'primary' | 'replica'; health: string; replicationOffset: number }
export interface Shard { slots: [number, number][]; nodes: ShardNode[] }

// CLUSTER SHARDS reply → typed shards. GLIDE returns RESP3 maps as arrays of {key,value}.
export function parseClusterShards(raw: unknown): Shard[] {
  const toObj = (v: any): Record<string, any> =>
    Array.isArray(v) && v.every((e) => e && typeof e === 'object' && 'key' in e)
      ? Object.fromEntries(v.map((e: any) => [String(e.key), e.value]))
      : Array.isArray(v) ? Object.fromEntries(Array.from({ length: v.length / 2 }, (_, i) => [String(v[2 * i]), v[2 * i + 1]])) : v;
  return (raw as any[]).map((s) => {
    const o = toObj(s);
    const slots = o.slots as number[];
    return {
      slots: Array.from({ length: slots.length / 2 }, (_, i) => [Number(slots[2 * i]), Number(slots[2 * i + 1])] as [number, number]),
      nodes: (o.nodes as any[]).map((n) => {
        const x = toObj(n);
        return { id: String(x.id), ip: String(x.ip), port: Number(x.port), role: String(x.role) === 'master' ? 'primary' : 'replica', health: String(x.health), replicationOffset: Number(x['replication-offset']) } as ShardNode;
      }),
    };
  });
}

// CRC16/XMODEM, as used for Valkey cluster key slots.
function crc16(buf: Buffer) {
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function keySlot(key: string) {
  const s = key.indexOf('{');
  if (s >= 0) {
    const e = key.indexOf('}', s + 1);
    if (e > s + 1) key = key.slice(s + 1, e);
  }
  return crc16(Buffer.from(key)) % 16384;
}

// One key per slot: `prefix:{<tag>}` with the smallest tag that hashes to each slot.
export function keyPerSlot(prefix: string): string[] {
  const out: string[] = new Array(16384);
  let found = 0;
  for (let i = 0; found < 16384; i++) {
    const slot = keySlot(`{${i}}`);
    if (out[slot] === undefined) (out[slot] = `${prefix}:{${i}}`), found++;
  }
  return out;
}
