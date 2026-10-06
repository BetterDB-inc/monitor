import { createHash } from 'crypto';

/**
 * ACL drift / live-reload confirmation (valkey-io/valkey#4355).
 *
 * Operators push ACLs with `ACL LOAD` or a config-management controller and then
 * have no cheap way to confirm the running server actually adopted the intended
 * ruleset — nor to notice when one node in a replication group is serving a
 * different ruleset than its peers. Upstream #4355 proposes an `ACL DIGEST`
 * command (an XOR of per-user hashes) for exactly this; the TSC vote is pending.
 *
 * The digest is trivially reproducible client-side today from `ACL LIST`, so the
 * advisory does not need to wait: it computes the same *shape* of digest (per-user
 * hash, XOR-combined) so that if `ACL DIGEST` ships, swapping the source is a
 * no-op with no change in behaviour.
 *
 * ## Digest algorithm
 *
 * Reproducible by hand, which matters for an auditable security signal:
 *
 *   1. Each `ACL LIST` line is `user <name> <rule> <rule> …`.
 *   2. The rule tokens are sorted lexicographically, so a server that reports the
 *      same ruleset in a different order digests identically. Case is preserved —
 *      key patterns and channel patterns are case-sensitive.
 *   3. Per-user digest = first 16 hex chars of `sha256("<name>\n<sorted rules>")`.
 *   4. Node digest = XOR of every per-user digest, as 8-byte values. XOR makes the
 *      node digest independent of user ordering and matches the upstream shape.
 *
 * ## Scope: per-shard plus cluster-wide
 *
 * `groupKey` is a shared `master_replid`, which on a cluster identifies ONE SHARD
 * (a primary and its replicas) — not the cluster. The shard pass confirms each
 * shard is internally consistent. The cluster pass (`clusterKey`, derived from
 * the live `CLUSTER NODES` id set) compares shards of the same cluster against
 * each other, so an `ACL LOAD` that missed one primary is detected.
 *
 * ## What is deliberately NOT carried out of this module
 *
 * Rule bodies. A finding names usernames and digests only — never key patterns,
 * channel patterns, command rules, or password hashes. `ACL LIST` output contains
 * hashed passwords (`#<sha256>`) and the key patterns a user can reach; pushing
 * those into the anomaly store and out through webhook payloads would turn a
 * consistency advisory into a credential-disclosure channel.
 */

/** Bytes of sha256 kept per digest. 8 bytes is ample for drift comparison. */
const DIGEST_BYTES = 8;
const EMPTY_DIGEST = '0'.repeat(DIGEST_BYTES * 2);

export interface AclDriftNode {
  connectionId: string;
  name?: string;
  /**
   * Replication group this node belongs to (a shared `master_replid`). Nodes with
   * an empty groupKey are never compared against anything.
   */
  groupKey: string;
  /**
   * Cluster this node belongs to, derived from the live `CLUSTER NODES` id set.
   * Empty when unknown (standalone, fetch failure) — excluded from cross-shard
   * comparison. Optional for backwards compatibility with shard-only callers.
   */
  clusterKey?: string;
  /** username → per-user digest. */
  userDigests: Record<string, string>;
  /** XOR of every per-user digest — the node's ACL revision fingerprint. */
  digest: string;
}

export interface AclDriftNodeDigest {
  connectionId: string;
  name?: string;
  digest: string;
}

/** One replication group whose nodes do not agree on their ACL state. */
export interface AclDrift {
  groupKey: string;
  /** Usernames that differ (or are missing) across the group. Sorted. */
  usernames: string[];
  /** Every node in the group with its digest, sorted by connection id. */
  nodes: AclDriftNodeDigest[];
}

/** One cluster whose shards do not agree on their ACL state. */
export interface AclClusterDrift {
  clusterKey: string;
  /** Distinct shard groupKeys participating, sorted. */
  groupKeys: string[];
  /** Usernames that differ (or are missing) across the cluster. Sorted. */
  usernames: string[];
  /** Every node in the cluster with its digest, sorted by connection id. */
  nodes: AclDriftNodeDigest[];
}

/**
 * Splits an `ACL LIST` line into tokens, keeping a selector `(...)` together as
 * ONE token.
 *
 * Selectors (Redis 7+/Valkey) render with spaces inside the parentheses —
 * `(%R~key2 +set)` — so a plain whitespace split fragments them into `(%R~key2`
 * and `+set)`. Sorting those fragments mixes them with the user's top-level
 * rules, and two servers rendering the same selector in a different position
 * digest differently: a false ACL_DRIFT on every deployment that uses selectors.
 */
function tokenizeAclLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of line ?? '') {
    if (char === '(') {
      depth += 1;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
    }
    if (/\s/.test(char) && depth === 0) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') {
    tokens.push(current);
  }
  return tokens;
}

/** Username and normalized rule text of one `ACL LIST` line. */
export function parseAclLine(line: string): { username: string; rules: string[] } | null {
  const tokens = tokenizeAclLine(line);
  if (tokens.length < 2 || tokens[0].toLowerCase() !== 'user') {
    return null;
  }
  return { username: tokens[1], rules: tokens.slice(2) };
}

/**
 * Canonical form of one rule token. A selector renders as `(...)` with its own
 * space-separated rules inside; those are as order-insensitive as the top-level
 * list, so they are sorted too. Without this, `(~k1 +get)` and `(+get ~k1)` —
 * the same grant — digest differently and read as drift.
 */
function normalizeAclRule(rule: string): string {
  if (!rule.startsWith('(') || !rule.endsWith(')')) {
    return rule;
  }
  const inner = rule.slice(1, -1);
  const parts = inner.split(/\s+/).filter((part) => {
    return part !== '';
  });
  return `(${parts.sort().join(' ')})`;
}

/**
 * Per-user digest: sha256 over the username and its lexicographically sorted
 * rules, truncated. Sorting makes it independent of the order the server happens
 * to render rules in, at the top level and inside each selector.
 */
export function aclUserDigest(username: string, rules: string[]): string {
  const normalized = rules.map(normalizeAclRule).sort().join(' ');
  return createHash('sha256')
    .update(`${username}\n${normalized}`)
    .digest('hex')
    .slice(0, DIGEST_BYTES * 2);
}

function xorHex(left: string, right: string): string {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  const out = Buffer.alloc(DIGEST_BYTES);
  for (let i = 0; i < DIGEST_BYTES; i++) {
    out[i] = (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return out.toString('hex');
}

/**
 * Folds a raw `ACL LIST` reply into per-user digests and the node digest.
 * Unparseable lines are skipped rather than poisoning the digest — a server that
 * grows a new line format should read as "no change" for the users we do
 * understand, not as universal drift.
 */
export function nodeAclDigest(aclList: string[]): {
  digest: string;
  userDigests: Record<string, string>;
} {
  const userDigests: Record<string, string> = {};
  let digest = EMPTY_DIGEST;

  for (const line of aclList) {
    const parsed = parseAclLine(line);
    if (parsed === null) {
      continue;
    }
    const userDigest = aclUserDigest(parsed.username, parsed.rules);
    userDigests[parsed.username] = userDigest;
    digest = xorHex(digest, userDigest);
  }

  return { digest, userDigests };
}

/**
 * Finds replication groups whose members disagree on ACL state, naming the users
 * responsible. A group of fewer than two nodes cannot drift; a group whose nodes
 * all share one digest is consistent.
 */
export function detectAclDrift(nodes: AclDriftNode[]): AclDrift[] {
  const groups = new Map<string, AclDriftNode[]>();
  for (const node of nodes) {
    if (!node.groupKey) {
      continue;
    }
    const group = groups.get(node.groupKey) ?? [];
    group.push(node);
    groups.set(node.groupKey, group);
  }

  const drifts: AclDrift[] = [];
  for (const [groupKey, group] of groups) {
    if (group.length < 2) {
      continue;
    }

    const digests = new Set(
      group.map((node) => {
        return node.digest;
      }),
    );
    if (digests.size === 1) {
      continue;
    }

    drifts.push({
      groupKey,
      usernames: differingUsernames(group),
      nodes: toDigests(group),
    });
  }

  return drifts;
}

/**
 * Stable signature for a drift, so the same disagreement dedupes across polls but
 * a change in WHICH users differ — or in any node's digest — alerts again.
 */
export function aclDriftSignature(drift: AclDrift): string {
  const nodePart = drift.nodes
    .map((node) => {
      return `${node.connectionId}:${node.digest}`;
    })
    .join(',');
  return `${drift.groupKey}|${drift.usernames.join(',')}|${nodePart}`;
}

/** Flags marking a CLUSTER NODES entry that has not settled or is dead. */
const NON_LIVE_CLUSTER_FLAGS = ['handshake', 'noaddr', 'fail', 'fail?'];

/**
 * Cluster identity from a gossip view: hash of sorted live node ids. Same
 * cluster converges to the same key; unrelated clusters never collide. Empty
 * when the view is missing so callers skip the cross-shard pass.
 */
export function clusterKeyFromNodes(
  nodes: ReadonlyArray<{ id?: string; flags?: string | ReadonlyArray<string> }> | undefined,
): string {
  const ids = (nodes ?? []).filter((node) => {
    const flags = Array.isArray(node.flags) ? node.flags : [node.flags ?? ''];
    return !!node.id && !NON_LIVE_CLUSTER_FLAGS.some((flag) => flags.includes(flag));
  });
  const sorted = ids
    .map((node) => node.id as string)
    .sort()
    .join(',');
  if (!sorted) {
    return '';
  }
  return `cluster:${createHash('sha256').update(sorted).digest('hex').slice(0, 16)}`;
}

/**
 * Finds clusters whose shards disagree on ACL state. Groups by clusterKey, then
 * requires at least two distinct shard groupKeys — a single monitored shard can
 * never drift against itself. Nodes without a clusterKey are excluded. Shards
 * are compared as units: when every shard shares a digest, the divergence is
 * within a shard and the shard pass already covers it.
 */
export function detectAclClusterDrift(nodes: AclDriftNode[]): AclClusterDrift[] {
  const clusters = new Map<string, AclDriftNode[]>();
  for (const node of nodes) {
    if (!node.clusterKey || !node.groupKey) {
      continue;
    }
    const cluster = clusters.get(node.clusterKey) ?? [];
    cluster.push(node);
    clusters.set(node.clusterKey, cluster);
  }

  const drifts: AclClusterDrift[] = [];
  for (const [clusterKey, cluster] of clusters) {
    const groupKeys = [...new Set(cluster.map((node) => node.groupKey))].sort();
    if (groupKeys.length < 2) {
      continue;
    }
    const byShard = new Map<string, Set<string>>();
    for (const node of cluster) {
      const digests = byShard.get(node.groupKey) ?? new Set<string>();
      digests.add(node.digest);
      byShard.set(node.groupKey, digests);
    }
    const [first, ...rest] = [...byShard.values()];
    const common = new Set([...first].filter((digest) => rest.every((set) => set.has(digest))));
    if (common.size > 0) {
      continue;
    }
    drifts.push({
      clusterKey,
      groupKeys,
      usernames: differingUsernames(cluster),
      nodes: toDigests(cluster),
    });
  }

  return drifts;
}

/** Stable signature for a cross-shard drift, namespaced apart from shard drifts. */
export function aclClusterDriftSignature(drift: AclClusterDrift): string {
  const nodePart = drift.nodes
    .map((node) => {
      return `${node.connectionId}:${node.digest}`;
    })
    .join(',');
  return `${drift.clusterKey}|${drift.usernames.join(',')}|${nodePart}`;
}

function differingUsernames(group: AclDriftNode[]): string[] {
  const all = new Set<string>();
  for (const node of group) {
    for (const username of Object.keys(node.userDigests)) {
      all.add(username);
    }
  }
  const differing: string[] = [];
  for (const username of all) {
    const perNode = new Set(
      group.map((node) => {
        return node.userDigests[username] ?? 'absent';
      }),
    );
    if (perNode.size > 1) {
      differing.push(username);
    }
  }
  return differing.sort();
}

function toDigests(group: AclDriftNode[]): AclDriftNodeDigest[] {
  return group
    .map((node) => {
      return { connectionId: node.connectionId, name: node.name, digest: node.digest };
    })
    .sort((a, b) => {
      return a.connectionId.localeCompare(b.connectionId);
    });
}
