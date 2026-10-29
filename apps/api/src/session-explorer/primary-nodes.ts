import { Logger, ServiceUnavailableException } from '@nestjs/common';
import Valkey from 'iovalkey';
import calculateSlot from 'cluster-key-slot';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import type { ClusterNode } from '../common/types/metrics.types';
import { MetricsParser } from '../database/parsers/metrics.parser';
import { tlsIdentityOptions } from '../database/adapters/tls-servername';
import { parseNodeAddress } from '../topology/membership-diff';

const NODE_TIMEOUT_MS = 5000;
const logger = new Logger('SessionExplorer');

export interface PrimaryRoute {
  client: Valkey;
  slots: number[][];
}

export interface PrimaryClients {
  clients: Valkey[];
  failed: number;
  routes: PrimaryRoute[] | null;
  failedRoutes: number[][][];
  touchesKeys: boolean;
  release: () => Promise<void>;
}

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

export function routeOf(primaries: PrimaryClients, key: string): Valkey | null {
  if (!primaries.routes) return primaries.clients[0] ?? null;
  const slot = calculateSlot(key);
  const route = primaries.routes.find((r) => inSlots(r.slots, slot));
  return route?.client ?? null;
}

const inSlots = (slots: number[][], slot: number) =>
  slots.some(([start, end]) => slot >= start && slot <= end);

export function failedNodeOf(primaries: PrimaryClients, key: string): number | null {
  const slot = calculateSlot(key);
  const index = primaries.failedRoutes.findIndex((slots) => inSlots(slots, slot));
  return index === -1 ? null : index;
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
    logger.warn(`Session reader for ${label} could not be opened: ${(err as Error).message}`);
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

const unavailable = (failed: number): PrimaryClients => ({
  clients: [],
  failed,
  routes: null,
  failedRoutes: [],
  touchesKeys: false,
  release: async () => undefined,
});

async function clusterNodes(seed: Reader): Promise<ClusterNode[] | null> {
  try {
    return MetricsParser.parseClusterNodes((await seed.client.call('CLUSTER', 'NODES')) as string);
  } catch (err) {
    logger.warn(`CLUSTER NODES failed on the session reader: ${(err as Error).message}`);
    return null;
  }
}

export async function primaryClients(db: DatabasePort): Promise<PrimaryClients> {
  const parent = db.getClient();
  const { clusterEnabled } = db.getCapabilities();
  const dbIndex = db.getActiveDbIndex?.() ?? parent.options.db ?? 0;
  const seed = await ownReader(parent, dbIndex);
  if (!seed) return unavailable(1);
  if (!clusterEnabled) {
    return {
      clients: [seed.client],
      failed: 0,
      routes: null,
      failedRoutes: [],
      touchesKeys: !seed.noTouch,
      release: async () => {
        seed.client.disconnect();
      },
    };
  }

  const nodes = await clusterNodes(seed);
  if (!nodes) {
    seed.client.disconnect();
    return unavailable(1);
  }
  const primaries = nodes.filter(isServingPrimary);
  const connected = await Promise.all(
    primaries.map((node) =>
      node.flags.includes('myself') ? seed : connectNode(parent, node, dbIndex),
    ),
  );
  if (!connected.includes(seed)) seed.client.disconnect();

  const clients: Valkey[] = [];
  const routes: PrimaryRoute[] = [];
  const failedRoutes: number[][][] = [];
  let touchesKeys = false;
  connected.forEach((reader, i) => {
    if (!reader) {
      failedRoutes.push(primaries[i].slots);
      return;
    }
    if (!reader.noTouch) touchesKeys = true;
    clients.push(reader.client);
    routes.push({ client: reader.client, slots: primaries[i].slots });
  });

  return {
    clients,
    failed: failedRoutes.length,
    routes,
    failedRoutes,
    touchesKeys,
    release: async () => {
      for (const client of clients) client.disconnect();
    },
  };
}

export async function withPrimaries<T>(
  db: DatabasePort,
  run: (primaries: PrimaryClients) => Promise<T>,
): Promise<T> {
  const primaries = await primaryClients(db);
  if (primaries.clients.length === 0) {
    throw new ServiceUnavailableException('Could not open a read connection to the server');
  }
  try {
    return await run(primaries);
  } finally {
    await primaries.release();
  }
}
