import Valkey from 'iovalkey';
import calculateSlot from 'cluster-key-slot';
import type { DatabasePort } from '../common/interfaces/database-port.interface';
import type { ClusterNode } from '../common/types/metrics.types';
import { tlsIdentityOptions } from '../database/adapters/tls-servername';
import { parseNodeAddress } from '../topology/membership-diff';

const NODE_TIMEOUT_MS = 5000;

export interface PrimaryRoute {
  client: Valkey;
  slots: number[][];
}

export interface PrimaryClients {
  clients: Valkey[];
  failed: number;
  routes: PrimaryRoute[] | null;
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
  const route = primaries.routes.find((r) =>
    r.slots.some(([start, end]) => slot >= start && slot <= end),
  );
  return route?.client ?? null;
}

const isServingPrimary = (node: ClusterNode) =>
  node.flags.includes('master') && node.slots.length > 0;

function nodeClient(parent: Valkey, node: ClusterNode): Valkey | null {
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

async function openReader(create: () => Valkey | null): Promise<Reader | null> {
  let client: Valkey | null = null;
  try {
    client = create();
    if (!client) return null;
    client.on('error', () => undefined);
    await client.connect();
    const noTouch = await client.call('CLIENT', 'NO-TOUCH', 'ON').then(
      () => true,
      () => false,
    );
    return { client, noTouch };
  } catch {
    client?.disconnect();
    return null;
  }
}

const connectNode = (parent: Valkey, node: ClusterNode) =>
  openReader(() => nodeClient(parent, node));

const sharedReader = (parent: Valkey) =>
  openReader(() => parent.duplicate({ ...READER_OPTIONS, commandTimeout: readerTimeout(parent) }));

export async function primaryClients(db: DatabasePort): Promise<PrimaryClients> {
  const parent = db.getClient();
  if (!db.getCapabilities().clusterEnabled) {
    const reader = await sharedReader(parent);
    return {
      clients: reader ? [reader.client] : [],
      failed: reader ? 0 : 1,
      routes: null,
      touchesKeys: reader ? !reader.noTouch : false,
      release: async () => {
        reader?.client.disconnect();
      },
    };
  }

  const primaries = (await db.getClusterNodes()).filter(isServingPrimary);
  const clients: Valkey[] = [];
  const routes: PrimaryRoute[] = [];
  let failed = 0;
  let touchesKeys = false;

  const connected = await Promise.all(primaries.map((node) => connectNode(parent, node)));
  connected.forEach((reader, i) => {
    if (!reader) {
      failed++;
      return;
    }
    const { client, noTouch } = reader;
    if (!noTouch) touchesKeys = true;
    clients.push(client);
    routes.push({ client, slots: primaries[i].slots });
  });

  return {
    clients,
    failed,
    routes,
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
  try {
    return await run(primaries);
  } finally {
    await primaries.release();
  }
}
