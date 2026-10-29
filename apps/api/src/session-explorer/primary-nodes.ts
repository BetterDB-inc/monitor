import { Logger, ServiceUnavailableException } from '@nestjs/common';
import Valkey from 'iovalkey';
import calculateSlot from 'cluster-key-slot';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import type { ClusterNode } from '../common/types/metrics.types';
import { MetricsParser } from '../database/parsers/metrics.parser';
import { tlsIdentityOptions } from '../database/adapters/tls-servername';
import { parseNodeAddress } from '../topology/membership-diff';

const NODE_TIMEOUT_MS = 5000;
const WARN_INTERVAL_MS = 60_000;
const logger = new Logger('SessionExplorer');
const lastWarned = new Map<string, number>();

function warnOnce(label: string, message: string): void {
  const now = Date.now();
  const last = lastWarned.get(label);
  if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
  lastWarned.set(label, now);
  logger.warn(message);
}

export interface PrimaryRoute {
  slots: number[][];
  client: Valkey | null;
}

export type ReadableRoute = PrimaryRoute & { client: Valkey };

export interface PrimaryClients {
  routes: PrimaryRoute[];
  touchesKeys: boolean;
  release: () => Promise<void>;
}

const ALL_SLOTS = [[0, 16383]];

export const UNCOVERED: PrimaryRoute = { slots: [], client: null };

const READER_OPTIONS = {
  lazyConnect: true,
  enableOfflineQueue: false,
  enableReadyCheck: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: NODE_TIMEOUT_MS,
  connectionName: 'BetterDB-Monitor-SessionExplorer',
};

const readerTimeout = (parent: Valkey): number => parent.options.commandTimeout ?? NODE_TIMEOUT_MS;

export const isReadable = (route: PrimaryRoute): route is ReadableRoute => route.client !== null;

export const readable = (primaries: PrimaryClients): ReadableRoute[] =>
  primaries.routes.filter(isReadable);

export const unreadable = (primaries: PrimaryClients): Set<PrimaryRoute> =>
  new Set(primaries.routes.filter((route) => !isReadable(route)));

export const union = (...sets: Set<PrimaryRoute>[]): Set<PrimaryRoute> =>
  new Set(sets.flatMap((set) => [...set]));

const inSlots = (slots: number[][], slot: number) =>
  slots.some(([start, end]) => slot >= start && slot <= end);

export function ownerOf(primaries: PrimaryClients, key: string): PrimaryRoute {
  const slot = calculateSlot(key);
  return primaries.routes.find((route) => inSlots(route.slots, slot)) ?? UNCOVERED;
}

const isServingPrimary = (node: ClusterNode) =>
  node.flags.includes('master') && node.slots.length > 0;

function nodeClient(parent: Valkey, node: ClusterNode, dbIndex: number): Valkey | null {
  const address = parseNodeAddress(node.address);
  if (!address) return null;
  const { username, password, tls } = parent.options;
  const {
    servername: _servername,
    checkServerIdentity: _checkServerIdentity,
    ...nodeTls
  } = tls ?? {};
  const client = new Valkey({
    host: address.host,
    port: address.port,
    username,
    password,
    db: dbIndex,
    tls: tls ? { ...nodeTls, ...tlsIdentityOptions(address.host, node.hostname) } : undefined,
    ...READER_OPTIONS,
    commandTimeout: readerTimeout(parent),
  });
  client.on('error', () => undefined);
  return client;
}

interface Reader {
  client: Valkey;
  noTouch: boolean;
}

async function openReader(label: string, create: () => Valkey | null): Promise<Reader | null> {
  let client: Valkey | null = null;
  try {
    client = create();
    if (!client) throw new Error('unparseable node address');
    client.on('error', () => undefined);
    await client.connect();
    const noTouch = await client.call('CLIENT', 'NO-TOUCH', 'ON').then(
      () => true,
      (err: Error) => {
        if (err.name !== 'ReplyError') throw err;
        return false;
      },
    );
    if (!noTouch) await client.ping();
    return { client, noTouch };
  } catch (err) {
    warnOnce(label, `Session reader for ${label} could not be opened: ${(err as Error).message}`);
    client?.disconnect();
    return null;
  }
}

const connectNode = (parent: Valkey, node: ClusterNode, dbIndex: number) =>
  openReader(node.address, () => nodeClient(parent, node, dbIndex));

const ownReader = (parent: Valkey, dbIndex: number) =>
  openReader(`${parent.options.host}:${parent.options.port}`, () =>
    parent.duplicate({ ...READER_OPTIONS, db: dbIndex, commandTimeout: readerTimeout(parent) }),
  );

const routesOf = (routes: PrimaryRoute[], touchesKeys: boolean): PrimaryClients => ({
  routes,
  touchesKeys,
  release: async () => {
    for (const { client } of routes) client?.disconnect();
  },
});

const unavailable = () => routesOf([{ slots: ALL_SLOTS, client: null }], false);

async function clusterNodes(seed: Reader): Promise<ClusterNode[] | null> {
  try {
    return MetricsParser.parseClusterNodes((await seed.client.call('CLUSTER', 'NODES')) as string);
  } catch (err) {
    logger.warn(`CLUSTER NODES failed on the session reader: ${(err as Error).message}`);
    return null;
  }
}

async function sharedTopology(db: DatabasePort, timeoutMs: number): Promise<ClusterNode[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
  });
  try {
    return await Promise.race([db.getClusterNodes(), timeout]);
  } catch (err) {
    warnOnce('topology', `Cluster topology could not be read: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function primaryClients(db: DatabasePort): Promise<PrimaryClients> {
  const parent = db.getClient();
  const { clusterEnabled } = db.getCapabilities();
  const dbIndex = db.getActiveDbIndex?.() ?? parent.options.db ?? 0;
  const seed = await ownReader(parent, dbIndex);
  if (!clusterEnabled) {
    return seed
      ? routesOf([{ slots: ALL_SLOTS, client: seed.client }], !seed.noTouch)
      : unavailable();
  }

  const nodes =
    (seed && (await clusterNodes(seed))) ?? (await sharedTopology(db, readerTimeout(parent)));
  if (!nodes) {
    seed?.client.disconnect();
    return unavailable();
  }
  const primaries = nodes.filter(isServingPrimary);
  const connected = await Promise.all(
    primaries.map((node) =>
      node.flags.includes('myself') ? seed : connectNode(parent, node, dbIndex),
    ),
  );
  if (seed && !connected.includes(seed)) seed.client.disconnect();

  return routesOf(
    primaries.map((node, i) => ({ slots: node.slots, client: connected[i]?.client ?? null })),
    connected.some((reader) => reader !== null && !reader.noTouch),
  );
}

export async function withPrimaries<T>(
  db: DatabasePort,
  run: (primaries: PrimaryClients) => Promise<T>,
): Promise<T> {
  const primaries = await primaryClients(db);
  if (readable(primaries).length === 0) {
    throw new ServiceUnavailableException('Could not open a read connection to the server');
  }
  try {
    return await run(primaries);
  } finally {
    await primaries.release();
  }
}
