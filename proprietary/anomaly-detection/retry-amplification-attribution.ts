import type {
  ClientCaptureSummary,
  ClientConnectionCaptureRow,
  ClientConnectionRow,
  ClientSnapshotGroupRow,
  NewClientConnectionGroup,
} from '@betterdb/shared';
import {
  clientAddrIp,
  clientConnectionKey,
  connectionOpenedAt,
} from '@app/storage/adapters/client-analytics-stats';
import { RETRY_AMP_BASELINE_WINDOWS, RETRY_AMP_WINDOW_MS } from './retry-amplification-detector';

export const RETRY_AMP_TOP_CONTRIBUTORS = 5;
export const RETRY_AMP_CONTRIBUTOR_GROWTH = 1.3;
export const RETRY_AMP_CLIENT_SNAPSHOTS = 6;
export const RETRY_AMP_MIN_COMMAND_RATE = 1;
export const RETRY_AMP_MIN_NEW_CONNECTIONS = 3;
export const RETRY_AMP_MAX_BASELINE_SCALE = 2;
/**
 * The longest part of an episode the stored captures are read for, and the
 * longest span before it they are compared with: as long as the detector's own
 * baseline (RETRY_AMP_BASELINE_WINDOWS windows, 30 minutes). A longer episode
 * is attributed over its newest RETRY_AMP_MAX_ATTRIBUTION_SPAN_MS, so the read
 * does not grow with the episode.
 */
export const RETRY_AMP_MAX_ATTRIBUTION_SPAN_MS = RETRY_AMP_BASELINE_WINDOWS * RETRY_AMP_WINDOW_MS;
/**
 * The most client_snapshots rows one attribution aggregates. Two spans of
 * RETRY_AMP_MAX_ATTRIBUTION_SPAN_MS at the default 60s capture are about 60
 * captures, so this holds about 4,000 clients. better-sqlite3 runs the read
 * synchronously, before the attribution timeout can fire; this many rows take
 * 2-3s there, under RETRY_AMP_ATTRIBUTION_TIMEOUT_MS. A read past it stops
 * after this many rows, and the finding ranks by command rate only.
 */
export const RETRY_AMP_MAX_CAPTURE_ROWS = 250_000;
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
  age?: unknown;
  'tot-cmds'?: unknown;
}

interface ClientCommandCount {
  key: string;
  keyKind: ContributorKeyKind;
  addr: string;
  /** takenAt - age * 1000, null without an age. */
  openedAt: number | null;
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

/** Connections per (name, user, ip) in the newest capture of the episode. */
export type ClientGroupCount = Pick<ClientSnapshotGroupRow, 'name' | 'user' | 'ip' | 'count'>;

export interface AttributionInput extends EpisodeClientSnapshots {
  capture: ClientGroupCount[];
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

function parseCount(value: unknown): number | null {
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
    const totalCommands = parseCount(client['tot-cmds']);
    if (totalCommands === null) continue;
    const age = parseCount(client.age);
    counts.set(client.id, {
      ...contributorKey(client),
      addr: client.addr,
      openedAt: age === null ? null : takenAt - age * 1000,
      totalCommands,
    });
  }
  return counts.size === 0 ? null : { takenAt, clients: counts };
}

type ClientIdentity = Pick<ClientCommandCount, 'key' | 'keyKind'>;

// The connection behind each reading: its client id, address and opening, as
// in the stored captures (connectionOpenedAt), so an id reused on another
// address, or on the same Unix socket after a server restart, is another
// connection.
function connectionKeys(snapshots: ClientCommandSnapshot[]): Map<ClientCommandCount, string> {
  const estimates = new Map<string, number[]>();
  for (const snapshot of snapshots) {
    for (const [clientId, client] of snapshot.clients) {
      const openedAt = client.openedAt ?? null;
      if (openedAt === null) continue;
      const key = clientConnectionKey(clientId, client.addr);
      const known = estimates.get(key);
      if (known === undefined) estimates.set(key, [openedAt]);
      else known.push(openedAt);
    }
  }
  for (const known of estimates.values()) known.sort((a, b) => a - b);
  const keys = new Map<ClientCommandCount, string>();
  for (const snapshot of snapshots) {
    for (const [clientId, client] of snapshot.clients) {
      const key = clientConnectionKey(clientId, client.addr);
      const estimate = client.openedAt ?? null;
      const openedAt = estimate === null ? null : connectionOpenedAt(estimates.get(key)!, estimate);
      keys.set(client, `${key} ${openedAt}`);
    }
  }
  return keys;
}

// A connection is one identity across snapshots: its newest reading names it,
// so a client caught before CLIENT SETNAME ran is counted under the name it set
// later. `snapshots` are in chronological order, so a later reading overwrites
// an earlier one.
function latestIdentities(
  snapshots: ClientCommandSnapshot[],
  keys: Map<ClientCommandCount, string>,
): Map<string, ClientIdentity> {
  const identities = new Map<string, ClientIdentity>();
  for (const snapshot of snapshots) {
    for (const client of snapshot.clients.values()) {
      identities.set(keys.get(client)!, { key: client.key, keyKind: client.keyKind });
    }
  }
  return identities;
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

export function hasRatePair<T extends EpisodeClientSnapshots>(
  snapshots: T,
): snapshots is T & {
  before: ClientCommandSnapshot;
  first: ClientCommandSnapshot;
  latest: ClientCommandSnapshot;
} {
  return snapshots.before !== null && snapshots.first !== null && snapshots.latest !== null;
}

export function selectClientSnapshots(
  history: ClientCommandSnapshot[],
  episodeStart: number,
  until: number,
  notBefore: number | null = null,
): EpisodeClientSnapshots {
  const preEpisode = history.filter(
    (s) => s.takenAt <= episodeStart && (notBefore === null || s.takenAt > notBefore),
  );
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
  keys: Map<ClientCommandCount, string>,
  identities: Map<string, ClientIdentity>,
): Array<{ identity: ClientIdentity; rate: number }> {
  const dtSec = (to.takenAt - from.takenAt) / 1000;
  if (dtSec <= 0) return [];
  const rates: Array<{ identity: ClientIdentity; rate: number }> = [];
  for (const [clientId, client] of to.clients) {
    // The earlier reading counts only for the same connection: an id reused
    // after a server restart starts from zero.
    const key = keys.get(client)!;
    const previous = from.clients.get(clientId);
    const earlier =
      previous !== undefined && keys.get(previous) === key ? previous.totalCommands : 0;
    if (client.totalCommands < earlier) continue;
    // Every reading of `to` is in `identities` (built from `to` among others).
    rates.push({ identity: identities.get(key)!, rate: (client.totalCommands - earlier) / dtSec });
  }
  return rates;
}

function addCommandGrowth(
  map: Map<string, ContributorAccumulator>,
  before: ClientCommandSnapshot,
  first: ClientCommandSnapshot,
  latest: ClientCommandSnapshot,
): void {
  const keys = connectionKeys([before, first, latest]);
  const identities = latestIdentities([before, first, latest], keys);
  for (const { identity, rate } of commandRates(before, first, keys, identities)) {
    accumulatorFor(map, identity).preEpisodeRate += rate;
  }
  for (const { identity, rate } of commandRates(first, latest, keys, identities)) {
    accumulatorFor(map, identity).episodeRate += rate;
  }
}

/**
 * New connections per (name, user, ip) that opened in [since, until]. The
 * baseline and the episode are split by opening time alone, so each part
 * counts the connections opened in it whichever capture first listed them,
 * and one that opened just before the episode counts once, in the baseline.
 * `connections` come from one storage read over the whole attribution span,
 * so a connection keeps the same identity whichever part it is counted in.
 */
export function newConnectionsBetween(
  connections: ClientConnectionRow[],
  since: number,
  until: number,
): NewClientConnectionGroup[] {
  const groups = new Map<string, NewClientConnectionGroup>();
  for (const { name, user, ip, openedAt } of connections) {
    if (openedAt < since || openedAt > until) continue;
    const key = JSON.stringify([name, user, ip]);
    const group = groups.get(key) ?? { name, user, ip, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * The connections per (name, user, ip) in the newest capture of the span;
 * none without a capture at or after `notBefore` (during the episode).
 */
export function latestCaptureGroups(
  summary: ClientCaptureSummary,
  notBefore: number,
): ClientGroupCount[] {
  const newest = summary.captures.reduce((at, row) => Math.max(at, row.capturedAt), -Infinity);
  if (newest < notBefore) return [];
  return summary.captures
    .filter((row) => row.capturedAt === newest)
    .map(({ name, user, ip, count }) => ({ name, user, ip, count }));
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
  // The highest id seen so far, not only in the previous capture: when the
  // connection holding it closes, the next capture's highest id drops, and the
  // ids up to it were already counted. Only a capture in which every connection
  // opened after the previous one (a server restart) starts it over.
  let highest = highestClientId(byCapture.get(times[0]) ?? []);
  for (let i = 1; i < times.length; i++) {
    const capturedAt = times[i];
    const rows = byCapture.get(capturedAt) ?? [];
    const current = highestClientId(rows);
    const restarted = rows.every((row) => capturedAt - row.oldestAge * 1000 >= times[i - 1]);
    if (current < highest && restarted) highest = current;
    const growth = current - highest;
    highest = Math.max(highest, current);
    if (capturedAt < since || capturedAt > until) continue;
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
  capture: ClientGroupCount[],
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
  if (hasRatePair(input)) {
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
