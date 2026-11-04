import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { parseReplicaLines, REPLICA_ROLES } from '../anomaly-detection/replication-stream';

const DNS_TTL_MS = 5 * 60_000;
const DNS_RETRY_MS = 30_000;
const DNS_TIMEOUT_MS = 5_000;

export interface ReplicaPair {
  primaryConnectionId: string;
  replicaAddr: string;
}

interface ReplicationView {
  role: 'primary' | 'replica';
  replid: string;
  host: string;
  port: number;
  replicaAddrs: string[];
}

interface ResolvedHost {
  ips: string[];
  expiresAt: number;
  failures: number;
}

export type HostResolver = (host: string) => Promise<string[]>;

const resolveHost: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

export class ReplicaPairing {
  private readonly views = new Map<string, ReplicationView>();
  private readonly hosts = new Map<string, ResolvedHost>();
  private readonly resolving = new Map<string, object>();

  constructor(
    private readonly resolver: HostResolver = resolveHost,
    private readonly now: () => number = Date.now,
  ) {}

  observe(
    connectionId: string,
    replication: Record<string, string | undefined> | undefined,
    instance: { host: string; port: number },
  ): void {
    const role = replication?.role;
    const replid = replication?.master_replid;
    const isReplica = role !== undefined && REPLICA_ROLES.has(role);
    if (!replication || !replid || (role !== 'master' && !isReplica)) {
      this.views.delete(connectionId);
      return;
    }
    this.views.set(connectionId, {
      role: isReplica ? 'replica' : 'primary',
      replid,
      host: instance.host,
      port: instance.port,
      replicaAddrs: isReplica
        ? []
        : parseReplicaLines(replication as Record<string, string>).map((line) => line.addr),
    });
    if (isReplica) this.refreshHost(instance.host);
  }

  forget(connectionId: string): void {
    const view = this.views.get(connectionId);
    this.views.delete(connectionId);
    if (view && ![...this.views.values()].some((other) => other.host === view.host)) {
      this.hosts.delete(view.host);
      this.resolving.delete(view.host);
    }
  }

  primaryFor(replicaConnectionId: string): ReplicaPair | null {
    const replica = this.views.get(replicaConnectionId);
    if (!replica || replica.role !== 'replica') return null;
    const pairs = this.primariesOf(replica.replid).flatMap(([primaryConnectionId, primary]) => {
      const replicaAddr = this.addrOf(replicaConnectionId, replica, primary);
      return replicaAddr ? [{ primaryConnectionId, replicaAddr }] : [];
    });
    return pairs.length === 1 ? pairs[0] : null;
  }

  replicaConnectionFor(primaryConnectionId: string, replicaAddr: string): string | null {
    const matches = [...this.views.keys()].filter((id) => {
      const pair = this.primaryFor(id);
      return pair?.primaryConnectionId === primaryConnectionId && pair.replicaAddr === replicaAddr;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  private primariesOf(replid: string): Array<[string, ReplicationView]> {
    return [...this.views].filter(([, view]) => view.role === 'primary' && view.replid === replid);
  }

  private addrOf(
    replicaConnectionId: string,
    replica: ReplicationView,
    primary: ReplicationView,
  ): string | null {
    const ips = isIP(replica.host) ? [replica.host] : (this.hosts.get(replica.host)?.ips ?? []);
    const byHost = primary.replicaAddrs.filter((addr) =>
      [replica.host, ...ips].some((host) => addr === `${host}:${replica.port}`),
    );
    if (byHost.length === 1) return byHost[0];
    if (byHost.length > 1 || isIP(replica.host) || !this.hosts.get(replica.host)?.failures) {
      return null;
    }

    const byPort = primary.replicaAddrs.filter((addr) => addr.endsWith(`:${replica.port}`));
    const samePortReplicas = [...this.views].filter(
      ([id, view]) =>
        id !== replicaConnectionId &&
        view.role === 'replica' &&
        view.replid === primary.replid &&
        view.port === replica.port,
    );
    return byPort.length === 1 && samePortReplicas.length === 0 ? byPort[0] : null;
  }

  private refreshHost(host: string): void {
    if (isIP(host) || this.resolving.has(host)) return;
    const cached = this.hosts.get(host);
    if (cached && this.now() < cached.expiresAt) return;
    const lookup = {};
    const current = () => this.resolving.get(host) === lookup;
    this.resolving.set(host, lookup);
    withTimeout(this.resolver(host), DNS_TIMEOUT_MS)
      .then((ips) => {
        if (current()) {
          this.hosts.set(host, { ips, expiresAt: this.now() + DNS_TTL_MS, failures: 0 });
        }
      })
      .catch(() => {
        if (!current()) return;
        const failures = (cached?.failures ?? 0) + 1;
        const retryIn = Math.min(DNS_RETRY_MS * 2 ** (failures - 1), DNS_TTL_MS);
        this.hosts.set(host, { ips: [], expiresAt: this.now() + retryIn, failures });
      })
      .finally(() => {
        if (current()) this.resolving.delete(host);
      });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
