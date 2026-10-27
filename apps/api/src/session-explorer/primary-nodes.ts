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
  commandTimeout: NODE_TIMEOUT_MS,
  connectionName: 'BetterDB-Monitor-SessionExplorer',
};

const isServingPrimary =(node: ClusterNode) =>
  node.flags.includes('master') && node.slots.length > 0;

function nodeClient(parent: Valkey, node: ClusterNode): Valkey | null {
  const address = parseNodeAddress(node.address);
  if (!address) return null;
  const { username, password, tls, commandTimeout } = parent.options;
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
    commandTimeout,
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

const orShared = (parent: Valkey, reader: Reader | null): Reader =>
  reader ?? { client: parent, noTouch: false };

const sharedReader = async (parent: Valkey) =>
  orShared(
    parent,
    await openReader(() =>
      parent.duplicate({ ...READER_OPTIONS, commandTimeout: parent.options.commandTimeout }),
    ),
  );

export async function primaryClients(db: DatabasePort): Promise<PrimaryClients> {
  const parent = db.getClient();
  if (!db.getCapabilities().clusterEnabled) {
    const { client: reader, noTouch } = await sharedReader(parent);
    return {
      clients: [reader],
      failed: 0,
      routes: null,
      touchesKeys: !noTouch,
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
  let touchesKeys = false;

  const connected = await Promise.all(
    primaries.map(async (node) => {
      const reader = await connectNode(parent, node);
      return node.flags.includes('myself') ? orShared(parent, reader) : reader;
    }),
  );
  connected.forEach((reader, i) => {
    if (!reader) {
      failed++;
      return;
    }
    const { client, noTouch } = reader;
    if (!noTouch) touchesKeys = true;
    clients.push(client);
    routes.push({ client, slots: primaries[i].slots });
    if (client !== parent) owned.push(client);
  });

  return {
    clients,
    failed,
    routes,
    touchesKeys,
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
