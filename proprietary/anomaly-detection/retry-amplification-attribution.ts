import type {
  ClientCaptureEntry,
  ClientSnapshotGroupRow,
  NewClientConnectionGroup,
  OwnClientConnection,
} from '@betterdb/shared';
import {
  clientAddrIp,
  clientConnectionKey,
  isOwnClientAt,
  ownClientSpans,
  type OwnClientSpans,
} from '@app/storage/adapters/client-analytics-stats';

export const RETRY_AMP_TOP_CONTRIBUTORS = 5;
export const RETRY_AMP_CONTRIBUTOR_GROWTH = 1.3;
export const RETRY_AMP_CLIENT_SNAPSHOTS = 6;
export const RETRY_AMP_MIN_COMMAND_RATE = 1;
export const RETRY_AMP_MIN_NEW_CONNECTIONS = 3;
export const RETRY_AMP_MAX_BASELINE_SCALE = 2;
// Default names of the connections BetterDB itself opens: the monitor (and its
// -keyscan, -Node-..., -Discovery clients), the agent and the CLI. The
// monitor's own open connections to the node are also known by client id
// (`ownClients`), which covers a custom connection name and a connection
// listed before CLIENT SETNAME ran on it. BetterDB-Migration-* stays visible
// on purpose.
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
  addr: string;
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
  /**
   * The monitor's own connections to the node, open and recently closed, by
   * CLIENT LIST id from the time each connected until it closed (see
   * DatabasePort.getOwnClientIds).
   */
  ownClients?: Iterable<OwnClientConnection>;
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
      addr: client.addr,
      totalCommands,
    });
  }
  return counts.size === 0 ? null : { takenAt, clients: counts };
}

type ClientIdentity = Pick<ClientCommandCount, 'key' | 'keyKind'>;

// A connection is one identity across snapshots: the newest reading of a
// client id on the same address names it, so a client caught before CLIENT
// SETNAME ran is counted under the name it set later. A reused id on another
// address is a different connection. `snapshots` are in chronological order,
// so a later reading overwrites an earlier one.
function latestIdentities(snapshots: ClientCommandSnapshot[]): Map<string, ClientIdentity> {
  const identities = new Map<string, ClientIdentity>();
  for (const snapshot of snapshots) {
    for (const [clientId, client] of snapshot.clients) {
      identities.set(clientConnectionKey(clientId, client.addr), {
        key: client.key,
        keyKind: client.keyKind,
      });
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
  identities: Map<string, ClientIdentity>,
  ownClients: OwnClientSpans,
): Array<{ identity: ClientIdentity; rate: number }> {
  const dtSec = (to.takenAt - from.takenAt) / 1000;
  if (dtSec <= 0) return [];
  const rates: Array<{ identity: ClientIdentity; rate: number }> = [];
  for (const [clientId, client] of to.clients) {
    // A reading of one of the monitor's own connections is not the
    // application's, whatever name the connection carries.
    if (isOwnClientAt(ownClients, clientId, to.takenAt)) continue;
    // The earlier reading counts only for the same connection: an id reused on
    // another address after a server restart starts from zero.
    const previous = from.clients.get(clientId);
    const earlier = previous?.addr === client.addr ? previous.totalCommands : 0;
    if (client.totalCommands < earlier) continue;
    // Every reading of `to` is in `identities` (built from `to` among others).
    const identity = identities.get(clientConnectionKey(clientId, client.addr))!;
    rates.push({ identity, rate: (client.totalCommands - earlier) / dtSec });
  }
  return rates;
}

function addCommandGrowth(
  map: Map<string, ContributorAccumulator>,
  before: ClientCommandSnapshot,
  first: ClientCommandSnapshot,
  latest: ClientCommandSnapshot,
  ownClients: OwnClientSpans,
): void {
  const identities = latestIdentities([before, first, latest]);
  for (const { identity, rate } of commandRates(before, first, identities, ownClients)) {
    accumulatorFor(map, identity).preEpisodeRate += rate;
  }
  for (const { identity, rate } of commandRates(first, latest, identities, ownClients)) {
    accumulatorFor(map, identity).episodeRate += rate;
  }
}

/**
 * One application connection seen in the attribution span: a (clientId, addr)
 * pair with the name and user of its newest row, when it opened (the earliest
 * `capturedAt - age` estimate over its rows) and the first capture that listed
 * it.
 */
export interface ClientConnectionRow {
  clientId: string;
  addr: string;
  name: string;
  user: string;
  ip: string;
  openedAt: number;
  firstCapturedAt: number;
}

/** Connections per (name, user, ip) in one capture, with the oldest among them. */
export interface ClientCaptureGroup extends ClientGroupCount {
  /** Age in seconds of the oldest connection of the group at the capture. */
  oldestAge: number;
}

/** One CLIENT LIST capture of the attribution span. */
export interface ClientCapture {
  capturedAt: number;
  /**
   * Highest numeric client id the capture listed, the monitor's own
   * connections included: every connection the server accepted consumed an id,
   * so the growth of this number between captures counts connections that
   * came and went between them.
   */
  maxClientId: number;
  /** The application's connections, the monitor's own left out. */
  groups: ClientCaptureGroup[];
}

export interface ClientCaptureSummary {
  /** The application's connections, the monitor's own left out. */
  connections: ClientConnectionRow[];
  /** In chronological order; a capture that listed only the monitor has no groups. */
  captures: ClientCapture[];
}

function groupKey(group: { name: string; user: string; ip: string }): string {
  return JSON.stringify([group.name, group.user, group.ip]);
}

/**
 * Aggregates one storage read of the attribution span (StoragePort
 * .getClientCaptureEntries) into the connections and captures the ranking
 * works from. Rows of the monitor's own connections (`ownClients`, by client
 * id from the start of each connect until its close) count toward each
 * capture's `maxClientId` and nowhere else, so the ids they consumed are
 * known while their connections are neither reconnects nor live connections
 * of the application. A row's name and user come from the storage read, which
 * resolves each (clientId, addr) to its newest reading, so a connection keeps
 * one identity whichever part of the span it is counted in. One pass over
 * the rows.
 */
export function summarizeClientCaptures(
  entries: ClientCaptureEntry[],
  ownClients: Iterable<OwnClientConnection> = [],
): ClientCaptureSummary {
  const spans = ownClientSpans(ownClients);
  const connections = new Map<string, ClientConnectionRow>();
  const captures = new Map<
    number,
    { capture: ClientCapture; groups: Map<string, ClientCaptureGroup> }
  >();
  for (const entry of entries) {
    let capture = captures.get(entry.capturedAt);
    if (capture === undefined) {
      capture = {
        capture: { capturedAt: entry.capturedAt, maxClientId: 0, groups: [] },
        groups: new Map(),
      };
      captures.set(entry.capturedAt, capture);
    }
    // Ids are decimal; anything else does not count toward the growth.
    if (/^\d+$/.test(entry.clientId)) {
      capture.capture.maxClientId = Math.max(capture.capture.maxClientId, Number(entry.clientId));
    }
    if (isOwnClientAt(spans, entry.clientId, entry.capturedAt)) continue;

    const key = groupKey(entry);
    const group = capture.groups.get(key);
    if (group === undefined) {
      const fresh = {
        name: entry.name,
        user: entry.user,
        ip: entry.ip,
        count: 1,
        oldestAge: entry.age,
      };
      capture.groups.set(key, fresh);
      capture.capture.groups.push(fresh);
    } else {
      group.count += 1;
      group.oldestAge = Math.max(group.oldestAge, entry.age);
    }

    const connectionKey = clientConnectionKey(entry.clientId, entry.addr);
    const openedAt = entry.capturedAt - entry.age * 1000;
    const known = connections.get(connectionKey);
    if (known === undefined) {
      connections.set(connectionKey, {
        clientId: entry.clientId,
        addr: entry.addr,
        name: entry.name,
        user: entry.user,
        ip: entry.ip,
        openedAt,
        firstCapturedAt: entry.capturedAt,
      });
    } else {
      known.openedAt = Math.min(known.openedAt, openedAt);
      known.firstCapturedAt = Math.min(known.firstCapturedAt, entry.capturedAt);
    }
  }
  return {
    connections: [...connections.values()],
    captures: [...captures.values()]
      .map(({ capture }) => capture)
      .sort((a, b) => a.capturedAt - b.capturedAt),
  };
}

/**
 * Connections that opened in [since, until] and were captured by `until`, per
 * (name, user, ip). `connections` come from one storage read over the whole
 * attribution span, so a connection keeps the same identity whichever part of
 * the span it is counted in.
 */
export function newConnectionsBetween(
  connections: ClientConnectionRow[],
  since: number,
  until: number,
): NewClientConnectionGroup[] {
  const groups = new Map<string, NewClientConnectionGroup>();
  for (const connection of connections) {
    if (connection.openedAt < since || connection.firstCapturedAt > until) continue;
    const key = groupKey(connection);
    const group = groups.get(key);
    if (group === undefined) {
      const { name, user, ip } = connection;
      groups.set(key, { name, user, ip, count: 1 });
    } else {
      group.count += 1;
    }
  }
  return [...groups.values()];
}

/**
 * The application's connections per (name, user, ip) in the newest capture of
 * the span, or null when there is none at or after `notBefore` (no capture
 * during the episode). The newest capture is the newest of all rows, so one
 * that lists only the monitor's own connections (every application client
 * mid-reconnect) is an empty list, not a fall-back to an older capture.
 */
export function latestCaptureGroups(
  summary: ClientCaptureSummary,
  notBefore: number,
): ClientGroupCount[] | null {
  const newest = summary.captures[summary.captures.length - 1];
  if (newest === undefined || newest.capturedAt < notBefore) return null;
  return newest.groups.map(({ name, user, ip, count }) => ({ name, user, ip, count }));
}

/**
 * Reconnects per (name, user, ip) in [since, until]: the connections observed
 * (`groups`), raised to the share of the client id growth between consecutive
 * captures that falls to the clients fresh in the later capture, so a retrier
 * whose connections come and go between captures is still counted. The ids the
 * monitor's own connections consumed (`ownClients` that started connecting in
 * the interval) are taken off the growth first. `captures` are in
 * chronological order.
 */
export function estimateNewConnections(
  groups: NewClientConnectionGroup[],
  captures: ClientCapture[],
  since: number,
  until: number,
  ownClients: Iterable<OwnClientConnection> = [],
): NewClientConnectionGroup[] {
  const estimates = new Map(groups.map((group) => [groupKey(group), { ...group }]));
  const ownConnectedAt = [...ownClients].map((own) => own.connectedAt);
  const shares = new Map<string, { group: ClientCaptureGroup; share: number }>();
  for (let i = 1; i < captures.length; i++) {
    const capture = captures[i];
    if (capture.capturedAt < since || capture.capturedAt > until) continue;
    const previous = captures[i - 1];
    let growth = capture.maxClientId - previous.maxClientId;
    for (const connectedAt of ownConnectedAt) {
      if (connectedAt > previous.capturedAt && connectedAt <= capture.capturedAt) growth -= 1;
    }
    if (growth <= 0) continue;
    const fresh = capture.groups.filter(
      (group) => capture.capturedAt - group.oldestAge * 1000 >= previous.capturedAt,
    );
    for (const group of fresh) {
      const key = groupKey(group);
      const entry = shares.get(key) ?? { group, share: 0 };
      entry.share += growth / fresh.length;
      shares.set(key, entry);
    }
  }
  for (const [key, { group, share }] of shares) {
    const estimate = estimates.get(key) ?? {
      name: group.name,
      user: group.user,
      ip: group.ip,
      count: 0,
    };
    estimates.set(key, { ...estimate, count: Math.max(estimate.count, Math.round(share)) });
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
    const ownClients = ownClientSpans(input.ownClients ?? []);
    addCommandGrowth(map, input.before, input.first, input.latest, ownClients);
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
