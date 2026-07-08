import type Valkey from 'iovalkey';
import { ScanOptions, ScanResult, ScanTarget } from './types';

/**
 * Adapt a raw iovalkey client into a ScanTarget the pure engine can drive.
 * Works for a standalone connection or a per-primary client in a cluster
 * fan-out.
 */
export function createValkeyScanTarget(name: string, client: Valkey): ScanTarget {
  return {
    name,
    async scan(cursor: string, opts: ScanOptions): Promise<ScanResult> {
      const args: string[] = [cursor, 'MATCH', opts.match, 'COUNT', String(opts.count)];
      if (opts.type) args.push('TYPE', opts.type);

      const reply = (await client.call('SCAN', ...args)) as [string, string[]];
      const nextCursor = Array.isArray(reply) ? String(reply[0]) : '0';
      const keys = Array.isArray(reply) && Array.isArray(reply[1]) ? reply[1].map(String) : [];
      return { cursor: nextCursor, keys };
    },
    async unlink(keys: string[]): Promise<number> {
      if (keys.length === 0) return 0;

      // Delete one key per pipelined command rather than a single variadic
      // UNLINK. A batch from SCAN spans many hash slots, and in cluster mode a
      // multi-key command whose keys don't share a slot is rejected with
      // CROSSSLOT — even when the node owns every slot involved. Per-key
      // deletes avoid that while still costing a single round-trip.
      const pipeline = client.pipeline();
      for (const key of keys) pipeline.unlink(key);
      const results = await pipeline.exec();
      if (!results) return 0;

      let removed = 0;
      for (const [err, res] of results) {
        if (!err && typeof res === 'number') removed += res;
      }
      return removed;
    },
  };
}
