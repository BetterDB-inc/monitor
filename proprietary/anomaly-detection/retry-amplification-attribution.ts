export const RETRY_AMP_TOP_CONTRIBUTORS = 5;

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
  snapshotIntervalMs: number;
  limit?: number;
}

interface ContributorAccumulator {
  key: string;
  keyKind: ContributorKeyKind;
  commands: number;
  lifetimeRate: number;
  newClientIds: Set<string>;
  latestClientIds: Set<string>;
}

export function contributorKey(client: { name: string; user: string; addr: string }): {
  key: string;
  keyKind: ContributorKeyKind;
} {
  if (client.name) return { key: client.name, keyKind: 'name' };
  if (client.user && client.user !== 'default') return { key: client.user, keyKind: 'user' };
  const host =
    client.addr.lastIndexOf(':') > 0
      ? client.addr.slice(0, client.addr.lastIndexOf(':'))
      : client.addr;
  return { key: host, keyKind: 'ip' };
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
      newClientIds: new Set(),
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
  snapshots: ClientSnapshotEntry[],
  snapshotIntervalMs: number,
): void {
  if (snapshots.length === 0) return;
  const newAgeSec = snapshotIntervalMs / 1000;
  const latestCapture = Math.max(...snapshots.map((s) => s.capturedAt));
  for (const snapshot of snapshots) {
    const acc = accumulatorFor(map, contributorKey(snapshot));
    if (snapshot.age < newAgeSec) acc.newClientIds.add(snapshot.clientId);
    if (snapshot.capturedAt === latestCapture) acc.latestClientIds.add(snapshot.clientId);
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
  addReconnects(map, input.snapshots, input.snapshotIntervalMs);

  const contributors = [...map.values()].map((acc) => {
    const growth = hasCommandRates && acc.lifetimeRate > 0 ? acc.commands / acc.lifetimeRate : null;
    return {
      key: acc.key,
      keyKind: acc.keyKind,
      commandRateGrowth: growth,
      newConnections: acc.newClientIds.size,
      connections: acc.latestClientIds.size,
    };
  });

  return contributors
    .filter(
      (c) => (c.commandRateGrowth !== null && c.commandRateGrowth > 1) || c.newConnections > 0,
    )
    .sort((a, b) => {
      const growthA = a.commandRateGrowth ?? 0;
      const growthB = b.commandRateGrowth ?? 0;
      if (growthA !== growthB) return growthB - growthA;
      if (a.newConnections !== b.newConnections) return b.newConnections - a.newConnections;
      return a.key.localeCompare(b.key);
    })
    .slice(0, input.limit ?? RETRY_AMP_TOP_CONTRIBUTORS);
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
