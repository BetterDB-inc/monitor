/**
 * Detects configuration drift across nodes that belong to the same
 * replication group (a primary and its attached replicas, or — for a cluster
 * shard — that shard's primary and replicas).
 *
 * Upstream valkey-io/valkey#1193 proposes an in-engine `CLUSTER CONFIG-SET`
 * command so an operator can set a config value across an entire cluster in
 * one shot, because today `CONFIG SET` only ever applies to the single node
 * it is sent to. That per-node application is exactly why drift happens: one
 * node quietly ends up with a different `maxmemory`, `maxmemory-policy`,
 * `appendonly`, etc. than its peers — a real source of incidents (eviction
 * behaving differently per node, one node not persisting, …). We cannot
 * change the engine, but we get the inverse of the proposed command for
 * free as a monitor: observe the config nodes in a group actually have and
 * alert when a CRITICAL key disagrees.
 *
 * Grouping is by `groupKey`, which the caller derives from each node's own
 * observed state (see `anomaly.service.ts`) — this module is intentionally a
 * pure function with no knowledge of connections, registries, or how config
 * was fetched, so it stays trivially unit-testable.
 */

export interface ConfigDriftNode {
  /** Monitor connection id this config snapshot came from. */
  connectionId: string;
  /** Human-readable connection name, for messages/UI. */
  name?: string;
  /**
   * Identifies the replication group this node belongs to (e.g. a shared
   * `master_replid`). Nodes with an empty/undefined groupKey are never
   * compared against anything.
   */
  groupKey: string;
  /** Curated config subset for this node, keyed by config parameter name. */
  config: Record<string, string>;
}

export interface ConfigDriftValue {
  connectionId: string;
  name?: string;
  value: string;
}

/** One config key that disagrees across a single replication group. */
export interface ConfigDrift {
  groupKey: string;
  key: string;
  /** The differing values, one entry per node that reported this key. */
  values: ConfigDriftValue[];
}

/**
 * Config keys that SHOULD be identical across every node in a replication
 * group. Deliberately excludes node-specific keys that legitimately differ
 * (bind, port, dir, replica-announce-ip/port, unixsocket, logfile,
 * requirepass, …) — comparing those would just be noise.
 */
export const DEFAULT_CONFIG_DRIFT_KEYS: readonly string[] = [
  'maxmemory',
  'maxmemory-policy',
  'appendonly',
  'save',
  'timeout',
  'maxclients',
  'maxmemory-clients',
];

/**
 * Encoding-threshold configs (valkey-io/valkey#3479): each controls when a
 * collection is stored in its compact encoding (listpack/intset) versus the
 * expanded one (hashtable/quicklist/skiplist). They must match across a
 * replication group because a node loading the same keys under different
 * thresholds silently RE-ENCODES them — an RDB restore/clone onto a divergent
 * node can bloat memory well past what the source needed. Kept as a labeled
 * subgroup (not merged into DEFAULT_CONFIG_DRIFT_KEYS) so the advisory can
 * explain that specific consequence.
 */
export const ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS: readonly string[] = [
  'hash-max-listpack-entries',
  'hash-max-listpack-value',
  'list-max-listpack-size',
  'set-max-intset-entries',
  'set-max-listpack-entries',
  'set-max-listpack-value',
  'zset-max-listpack-entries',
  'zset-max-listpack-value',
];

const ENCODING_THRESHOLD_KEY_SET: ReadonlySet<string> = new Set(
  ENCODING_THRESHOLD_CONFIG_DRIFT_KEYS,
);

/** Whether a drifted key belongs to the encoding-threshold subgroup. */
export function isEncodingThresholdKey(key: string): boolean {
  return ENCODING_THRESHOLD_KEY_SET.has(key);
}

/**
 * Groups `nodes` by `groupKey` and, for each curated key, compares the value
 * reported by every node in the group. A key is reported as drifted when at
 * least two nodes in the group know the key AND disagree on its value.
 *
 * Nodes that didn't report a key (e.g. a transient CONFIG GET failure, or a
 * key unsupported on that server version) are simply excluded from that
 * key's comparison rather than treated as a distinct/drifted value. Groups
 * with fewer than two members have nothing to compare, so they never
 * produce a finding — including the case where only one node of a group is
 * monitored at all.
 */
export function detectConfigDrift(
  nodes: ConfigDriftNode[],
  keys: readonly string[],
): ConfigDrift[] {
  const groups = new Map<string, ConfigDriftNode[]>();
  for (const node of nodes) {
    if (!node.groupKey) continue;
    const bucket = groups.get(node.groupKey);
    if (bucket) {
      bucket.push(node);
    } else {
      groups.set(node.groupKey, [node]);
    }
  }

  const drifts: ConfigDrift[] = [];
  for (const [groupKey, groupNodes] of groups) {
    if (groupNodes.length < 2) continue; // nothing to compare a lone node against

    for (const key of keys) {
      const values: ConfigDriftValue[] = [];
      for (const node of groupNodes) {
        const value = node.config[key];
        if (value === undefined) continue;
        values.push({ connectionId: node.connectionId, name: node.name, value });
      }
      if (values.length < 2) continue;

      const distinct = new Set(values.map((v) => v.value));
      if (distinct.size > 1) {
        drifts.push({ groupKey, key, values });
      }
    }
  }

  return drifts;
}

/**
 * Stable signature for a drift finding, used to dedupe repeat alerts across
 * polls. Independent of node ordering; changes if the exact set of
 * (connection, value) pairs changes — e.g. a node's value changes, or a node
 * joins/leaves the disagreeing set — so a genuinely new mismatch pattern
 * re-alerts, while a converged (or unchanged) one does not re-fire every poll.
 */
export function configDriftSignature(drift: ConfigDrift): string {
  const valuePart = drift.values
    .map((v) => `${v.connectionId}=${v.value}`)
    .sort()
    .join(',');
  return `${drift.groupKey}|${drift.key}|${valuePart}`;
}
