import type { NewClientConnectionGroup } from '@betterdb/shared';

export const RETRY_AMP_TOP_CONTRIBUTORS = 5;
export const RETRY_AMP_SNAPSHOT_LIMIT = 50_000;
export const RETRY_AMP_CONTRIBUTOR_GROWTH = 1.3;
export const RETRY_AMP_ATTRIBUTION_MIN_WINDOWS = 2;
export const RETRY_AMP_FIRST_SNAPSHOT_ATTEMPTS = 3;

export type ContributorKeyKind = 'name' | 'user' | 'ip';

export interface RetryAmplificationContributor {
  key: string;
  keyKind: ContributorKeyKind;
  commandRateGrowth: number | null;
  newConnections: number;
  connections: number;
}

export interface ClientListEntry {
  id: string;
  addr: string;
  name: string;
  user: string;
  age: number;
  [field: string]: unknown;
}

export interface ClientSnapshotEntry {
  clientId: string;
  addr: string;
  name: string;
  user: string;
  age: number;
  capturedAt: number;
}

interface ClientCommandCount {
  key: string;
  keyKind: ContributorKeyKind;
  totalCommands: number;
  ageSec: number;
}

export interface ClientCommandSnapshot {
  takenAt: number;
  clients: Map<string, ClientCommandCount>;
}

export interface AttributionInput {
  first: ClientCommandSnapshot | null;
  latest: ClientCommandSnapshot | null;
  snapshots: ClientSnapshotEntry[];
  newConnections: NewClientConnectionGroup[];
  limit?: number;
}

interface ContributorAccumulator {
  key: string;
  keyKind: ContributorKeyKind;
  commands: number;
  lifetimeRate: number;
  newConnections: number;
  latestClientIds: Set<string>;
}

function hostKey(
  name: string,
  user: string,
  host: string,
): {
  key: string;
  keyKind: ContributorKeyKind;
} {
  if (name) return { key: name, keyKind: 'name' };
  if (user && user !== 'default') return { key: user, keyKind: 'user' };
  return { key: host, keyKind: 'ip' };
}

export function contributorKey(client: { name: string; user: string; addr: string }): {
  key: string;
  keyKind: ContributorKeyKind;
} {
  const host =
    client.addr.lastIndexOf(':') > 0
      ? client.addr.slice(0, client.addr.lastIndexOf(':'))
      : client.addr;
  return hostKey(client.name, client.user, host);
}

function parseTotalCommands(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function readClientCommandCounts(
  clients: ClientListEntry[],
  takenAt: number,
): ClientCommandSnapshot | null {
  const counts = new Map<string, ClientCommandCount>();
  for (const client of clients) {
    const totalCommands = parseTotalCommands(client['tot-cmds']);
    if (totalCommands === null) continue;
    counts.set(client.id, {
      ...contributorKey(client),
      totalCommands,
      ageSec: Number.isFinite(client.age) ? client.age : 0,
    });
  }
  return counts.size === 0 ? null : { takenAt, clients: counts };
}

function accumulatorFor(
  map: Map<string, ContributorAccumulator>,
  identity: { key: string; keyKind: ContributorKeyKind },
): ContributorAccumulator {
  const id = `${identity.keyKind}:${identity.key}`;
  let acc = map.get(id);
  if (acc === undefined) {
    acc = {
      ...identity,
      commands: 0,
      lifetimeRate: 0,
      newConnections: 0,
      latestClientIds: new Set(),
    };
    map.set(id, acc);
  }
  return acc;
}

function addCommandGrowth(
  map: Map<string, ContributorAccumulator>,
  first: ClientCommandSnapshot,
  latest: ClientCommandSnapshot,
): boolean {
  const dtSec = (latest.takenAt - first.takenAt) / 1000;
  if (dtSec <= 0) return false;
  let measured = false;
  for (const [clientId, before] of first.clients) {
    const after = latest.clients.get(clientId);
    if (after === undefined || after.totalCommands < before.totalCommands) continue;
    if (before.ageSec <= 0) continue;
    const acc = accumulatorFor(map, before);
    acc.commands += (after.totalCommands - before.totalCommands) / dtSec;
    acc.lifetimeRate += before.totalCommands / before.ageSec;
    measured = true;
  }
  return measured;
}

function addReconnects(
  map: Map<string, ContributorAccumulator>,
  groups: NewClientConnectionGroup[],
  snapshots: ClientSnapshotEntry[],
): void {
  for (const group of groups) {
    accumulatorFor(map, hostKey(group.name, group.user, group.ip)).newConnections += group.count;
  }
  if (snapshots.length === 0) return;
  const latestCapture = snapshots.reduce((max, s) => Math.max(max, s.capturedAt), 0);
  for (const snapshot of snapshots) {
    if (snapshot.capturedAt !== latestCapture) continue;
    accumulatorFor(map, contributorKey(snapshot)).latestClientIds.add(snapshot.clientId);
  }
}

export function rankRetryAmplificationContributors(
  input: AttributionInput,
): RetryAmplificationContributor[] {
  const map = new Map<string, ContributorAccumulator>();
  const hasCommandRates =
    input.first !== null &&
    input.latest !== null &&
    addCommandGrowth(map, input.first, input.latest);
  addReconnects(map, input.newConnections, input.snapshots);

  const contributors = [...map.values()].map((acc) => {
    const growth = hasCommandRates && acc.lifetimeRate > 0 ? acc.commands / acc.lifetimeRate : null;
    return {
      key: acc.key,
      keyKind: acc.keyKind,
      commandRateGrowth: growth,
      newConnections: acc.newConnections,
      connections: acc.latestClientIds.size,
    };
  });

  const byGrowth = contributors
    .filter(
      (c) => c.commandRateGrowth !== null && c.commandRateGrowth >= RETRY_AMP_CONTRIBUTOR_GROWTH,
    )
    .sort((a, b) => {
      const diff = (b.commandRateGrowth ?? 0) - (a.commandRateGrowth ?? 0);
      return diff !== 0 ? diff : a.key.localeCompare(b.key);
    });
  const byReconnects = contributors
    .filter((c) => c.newConnections > 0)
    .sort((a, b) => {
      const diff = b.newConnections - a.newConnections;
      return diff !== 0 ? diff : a.key.localeCompare(b.key);
    });

  const limit = input.limit ?? RETRY_AMP_TOP_CONTRIBUTORS;
  const ranked: RetryAmplificationContributor[] = [];
  for (let i = 0; ranked.length < limit && (i < byGrowth.length || i < byReconnects.length); i++) {
    for (const candidate of [byGrowth[i], byReconnects[i]]) {
      if (candidate !== undefined && !ranked.includes(candidate) && ranked.length < limit) {
        ranked.push(candidate);
      }
    }
  }
  return ranked;
}

export function describeRetryAmplificationContributors(
  contributors: RetryAmplificationContributor[] | null,
): string {
  if (contributors === null) return 'Client attribution unavailable.';
  if (contributors.length === 0) return 'No client stood out.';
  const parts = contributors.map((c) => {
    const details: string[] = [];
    if (c.commandRateGrowth !== null) details.push(`cmds ${c.commandRateGrowth.toFixed(1)}×`);
    if (c.newConnections > 0) details.push(`${c.newConnections} reconnects`);
    return `${c.keyKind} ${c.key} (${details.join(', ')})`;
  });
  return `Top clients: ${parts.join('; ')}.`;
}
