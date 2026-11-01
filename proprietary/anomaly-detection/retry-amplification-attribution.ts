import type { ClientSnapshotGroupRow, NewClientConnectionGroup } from '@betterdb/shared';
import { clientAddrIp } from '@app/storage/adapters/client-analytics-stats';

export const RETRY_AMP_TOP_CONTRIBUTORS = 5;
export const RETRY_AMP_CONTRIBUTOR_GROWTH = 1.3;
export const RETRY_AMP_CLIENT_SNAPSHOTS = 4;

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

interface ClientCommandCount {
  key: string;
  keyKind: ContributorKeyKind;
  totalCommands: number;
}

export interface ClientCommandSnapshot {
  takenAt: number;
  clients: Map<string, ClientCommandCount>;
}

export interface EpisodeClientSnapshots {
  before: ClientCommandSnapshot | null;
  first: ClientCommandSnapshot | null;
  latest: ClientCommandSnapshot | null;
}

export interface AttributionInput extends EpisodeClientSnapshots {
  capture: ClientSnapshotGroupRow[];
  newConnections: NewClientConnectionGroup[];
  limit?: number;
}

interface ContributorAccumulator {
  key: string;
  keyKind: ContributorKeyKind;
  episodeRate: number;
  preEpisodeRate: number;
  newConnections: number;
  connections: number;
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
  return hostKey(client.name, client.user, clientAddrIp(client.addr));
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
      episodeRate: 0,
      preEpisodeRate: 0,
      newConnections: 0,
      connections: 0,
    };
    map.set(id, acc);
  }
  return acc;
}

export function pushClientSnapshot(
  history: ClientCommandSnapshot[],
  snapshot: ClientCommandSnapshot,
  episodeStart: number | null,
): ClientCommandSnapshot[] {
  if (episodeStart === null) {
    return [...history, snapshot].slice(-RETRY_AMP_CLIENT_SNAPSHOTS);
  }
  const preEpisode = history.filter((s) => s.takenAt <= episodeStart).slice(-2);
  return [...preEpisode, snapshot];
}

export function selectClientSnapshots(
  history: ClientCommandSnapshot[],
  episodeStart: number,
  until: number,
): EpisodeClientSnapshots {
  const preEpisode = history.filter((s) => s.takenAt <= episodeStart);
  const during = history.filter((s) => s.takenAt > episodeStart && s.takenAt <= until);
  return {
    before: preEpisode[preEpisode.length - 2] ?? null,
    first: preEpisode[preEpisode.length - 1] ?? null,
    latest: during[during.length - 1] ?? null,
  };
}

function commandRates(
  from: ClientCommandSnapshot,
  to: ClientCommandSnapshot,
): Array<{ client: ClientCommandCount; rate: number }> {
  const dtSec = (to.takenAt - from.takenAt) / 1000;
  if (dtSec <= 0) return [];
  const rates: Array<{ client: ClientCommandCount; rate: number }> = [];
  for (const [clientId, client] of to.clients) {
    const earlier = from.clients.get(clientId)?.totalCommands ?? 0;
    if (client.totalCommands < earlier) continue;
    rates.push({ client, rate: (client.totalCommands - earlier) / dtSec });
  }
  return rates;
}

function addCommandGrowth(
  map: Map<string, ContributorAccumulator>,
  before: ClientCommandSnapshot,
  first: ClientCommandSnapshot,
  latest: ClientCommandSnapshot,
): void {
  for (const { client, rate } of commandRates(before, first)) {
    accumulatorFor(map, client).preEpisodeRate += rate;
  }
  for (const { client, rate } of commandRates(first, latest)) {
    accumulatorFor(map, client).episodeRate += rate;
  }
}

function addReconnects(
  map: Map<string, ContributorAccumulator>,
  groups: NewClientConnectionGroup[],
  capture: ClientSnapshotGroupRow[],
): void {
  for (const group of groups) {
    accumulatorFor(map, hostKey(group.name, group.user, group.ip)).newConnections += group.count;
  }
  for (const group of capture) {
    accumulatorFor(map, hostKey(group.name, group.user, group.ip)).connections += group.count;
  }
}

export function rankRetryAmplificationContributors(
  input: AttributionInput,
): RetryAmplificationContributor[] {
  const map = new Map<string, ContributorAccumulator>();
  if (input.before !== null && input.first !== null && input.latest !== null) {
    addCommandGrowth(map, input.before, input.first, input.latest);
  }
  addReconnects(map, input.newConnections, input.capture);

  const contributors = [...map.values()].map((acc) => {
    const growth = acc.preEpisodeRate > 0 ? acc.episodeRate / acc.preEpisodeRate : null;
    return {
      key: acc.key,
      keyKind: acc.keyKind,
      commandRateGrowth: growth,
      newConnections: acc.newConnections,
      connections: acc.connections,
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
