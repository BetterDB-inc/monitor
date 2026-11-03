import type {
  ClientConnectionCaptureRow,
  ClientSnapshotGroupRow,
  NewClientConnectionGroup,
} from '@betterdb/shared';
import { clientAddrIp } from '@app/storage/adapters/client-analytics-stats';

export const RETRY_AMP_TOP_CONTRIBUTORS = 5;
export const RETRY_AMP_CONTRIBUTOR_GROWTH = 1.3;
export const RETRY_AMP_CLIENT_SNAPSHOTS = 6;
export const RETRY_AMP_MIN_COMMAND_RATE = 1;
export const RETRY_AMP_MIN_NEW_CONNECTIONS = 3;
// Names of the connections BetterDB itself opens: the monitor (and its
// -keyscan, -Node-..., -Discovery clients), the agent and the CLI.
// BetterDB-Migration-* stays visible on purpose.
const OWN_CLIENT_NAMES = ['BetterDB-Monitor', 'BetterDB-Agent', 'BetterDB-CLI'];

function isMonitorClientName(name: string): boolean {
  return OWN_CLIENT_NAMES.some((own) => name === own || name.startsWith(`${own}-`));
}

export type ContributorKeyKind = 'name' | 'user' | 'ip';

export interface RetryAmplificationContributor {
  key: string;
  keyKind: ContributorKeyKind;
  commandRateGrowth: number | null;
  newConnections: number;
  connections: number;
}

export interface ClientListEntry {
  flags?: string;
  id: string;
  addr: string;
  name: string;
  user: string;
  'tot-cmds'?: unknown;
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
  baselineConnections?: NewClientConnectionGroup[];
  limit?: number;
}

interface ContributorAccumulator {
  key: string;
  keyKind: ContributorKeyKind;
  episodeRate: number;
  preEpisodeRate: number;
  baselineConnections: number;
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
    if (/[SM]/.test(client.flags ?? '')) continue;
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
      baselineConnections: 0,
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

function highestClientId(rows: ClientConnectionCaptureRow[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.maxClientId), 0);
}

export function estimateNewConnections(
  groups: NewClientConnectionGroup[],
  captures: ClientConnectionCaptureRow[],
  since: number,
  until: number,
): NewClientConnectionGroup[] {
  const byCapture = new Map<number, ClientConnectionCaptureRow[]>();
  for (const row of captures) {
    const rows = byCapture.get(row.capturedAt);
    if (rows) rows.push(row);
    else byCapture.set(row.capturedAt, [row]);
  }
  const estimates = new Map(
    groups.map((group) => [JSON.stringify([group.name, group.user, group.ip]), { ...group }]),
  );
  const shares = new Map<string, { row: ClientConnectionCaptureRow; share: number }>();
  const times = [...byCapture.keys()].sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    const capturedAt = times[i];
    if (capturedAt < since || capturedAt > until) continue;
    const rows = byCapture.get(capturedAt) ?? [];
    const previous = byCapture.get(times[i - 1]) ?? [];
    const growth = highestClientId(rows) - highestClientId(previous);
    if (growth <= 0) continue;
    const fresh = rows.filter((row) => capturedAt - row.oldestAge * 1000 >= times[i - 1]);
    for (const row of fresh) {
      const key = JSON.stringify([row.name, row.user, row.ip]);
      const entry = shares.get(key) ?? { row, share: 0 };
      entry.share += growth / fresh.length;
      shares.set(key, entry);
    }
  }
  for (const [key, { row, share }] of shares) {
    const group = estimates.get(key) ?? { name: row.name, user: row.user, ip: row.ip, count: 0 };
    estimates.set(key, { ...group, count: Math.max(group.count, Math.round(share)) });
  }
  return [...estimates.values()];
}

function addReconnects(
  map: Map<string, ContributorAccumulator>,
  groups: NewClientConnectionGroup[],
  capture: ClientSnapshotGroupRow[],
  baseline: NewClientConnectionGroup[],
): void {
  for (const group of groups) {
    accumulatorFor(map, hostKey(group.name, group.user, group.ip)).newConnections += group.count;
  }
  for (const group of baseline) {
    const key = hostKey(group.name, group.user, group.ip);
    accumulatorFor(map, key).baselineConnections += group.count;
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
  addReconnects(map, input.newConnections, input.capture, input.baselineConnections ?? []);
  for (const [id, acc] of map) {
    if (acc.keyKind === 'name' && isMonitorClientName(acc.key)) map.delete(id);
  }

  const contributorOf = new Map(
    [...map.values()].map((acc) => {
      const growth = acc.preEpisodeRate > 0 ? acc.episodeRate / acc.preEpisodeRate : null;
      const contributor = {
        key: acc.key,
        keyKind: acc.keyKind,
        commandRateGrowth: growth,
        newConnections: acc.newConnections,
        connections: acc.connections,
      };
      return [acc, contributor] as const;
    }),
  );

  const rateIncrease = (acc: ContributorAccumulator) => acc.episodeRate - acc.preEpisodeRate;
  const byGrowth = [...contributorOf.entries()]
    .filter(
      ([acc, c]) =>
        acc.episodeRate >= RETRY_AMP_MIN_COMMAND_RATE &&
        c.commandRateGrowth !== null &&
        c.commandRateGrowth >= RETRY_AMP_CONTRIBUTOR_GROWTH,
    )
    .sort(([a, contributorA], [b, contributorB]) => {
      const diff = rateIncrease(b) - rateIncrease(a);
      return diff !== 0 ? diff : contributorA.key.localeCompare(contributorB.key);
    })
    .map(([, contributor]) => contributor);
  const excessConnections = (acc: ContributorAccumulator) =>
    acc.newConnections - acc.baselineConnections;
  const byReconnects = [...map.values()]
    .filter(
      (acc) =>
        acc.newConnections >= RETRY_AMP_MIN_NEW_CONNECTIONS &&
        acc.newConnections >= RETRY_AMP_CONTRIBUTOR_GROWTH * acc.baselineConnections,
    )
    .sort((a, b) => {
      const diff = excessConnections(b) - excessConnections(a);
      return diff !== 0 ? diff : a.key.localeCompare(b.key);
    })
    .map((acc) => contributorOf.get(acc)!);

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
