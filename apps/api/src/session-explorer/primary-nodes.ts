import Valkey from 'iovalkey';
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
  release: () => Promise<void>;
}

const READER_OPTIONS = {
  lazyConnect: true,
  enableOfflineQueue: false,
  enableReadyCheck: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
  connectTimeout: NODE_TIMEOUT_MS,
  commandTimeout: NODE_TIMEOUT_MS,
  connectionName: 'BetterDB-Monitor-SessionExplorer',
};

const isServingPrimary =(node: ClusterNode) =>
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
  });
  client.on('error', () => undefined);
  return client;
}

async function openReader(create: () => Valkey | null): Promise<Valkey | null> {
  let client: Valkey | null = null;
  try {
    client = create();
    if (!client) return null;
    client.on('error', () => undefined);
    await client.connect();
    await client.call('CLIENT', 'NO-TOUCH', 'ON').catch(() => undefined);
    return client;
  } catch {
    client?.disconnect();
    return null;
  }
}

const connectNode = (parent: Valkey, node: ClusterNode) =>
  openReader(() => nodeClient(parent, node));

const sharedReader = async (parent: Valkey) =>
  (await openReader(() =>
    parent.duplicate({ ...READER_OPTIONS, commandTimeout: parent.options.commandTimeout }),
  )) ?? parent;

export async function primaryClients(db: DatabasePort): Promise<PrimaryClients> {
  const parent = db.getClient();
  if (!db.getCapabilities().clusterEnabled) {
    const reader = await sharedReader(parent);
    return {
      clients: [reader],
      failed: 0,
      routes: null,
      release: async () => {
        if (reader !== parent) reader.disconnect();
      },
    };
  }

  const primaries = (await db.getClusterNodes()).filter(isServingPrimary);
  const owned: Valkey[] = [];
  const clients: Valkey[] = [];
  const routes: PrimaryRoute[] = [];
  let failed = 0;

  const connected = await Promise.all(
    primaries.map((node) =>
      node.flags.includes('myself') ? sharedReader(parent) : connectNode(parent, node),
    ),
  );
  connected.forEach((client, i) => {
    if (!client) {
      failed++;
      return;
    }
    clients.push(client);
    routes.push({ client, slots: primaries[i].slots });
    if (client !== parent) owned.push(client);
  });

  return {
    clients,
    failed,
    routes,
    release: async () => {
      for (const client of owned) client.disconnect();
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
