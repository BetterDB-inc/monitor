import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { parseReplicaLines } from '../anomaly-detection/replication-stream';

const DNS_TTL_MS = 5 * 60_000;

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
  resolvedAt: number;
}

export type HostResolver = (host: string) => Promise<string[]>;

const resolveHost: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

export class ReplicaPairing {
  private readonly views = new Map<string, ReplicationView>();
  private readonly hosts = new Map<string, ResolvedHost>();
  private readonly resolving = new Set<string>();

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
    const isReplica = role === 'slave' || role === 'replica';
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
    this.views.delete(connectionId);
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
    const primary = this.views.get(primaryConnectionId);
    if (!primary || primary.role !== 'primary') return null;
    const matches = [...this.views].filter(
      ([id, view]) =>
        view.role === 'replica' &&
        view.replid === primary.replid &&
        this.addrOf(id, view, primary) === replicaAddr,
    );
    return matches.length === 1 ? matches[0][0] : null;
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
    if (byHost.length > 1) return null;

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
    if (cached && this.now() - cached.resolvedAt < DNS_TTL_MS) return;
    this.resolving.add(host);
    this.resolver(host)
      .then((ips) => this.hosts.set(host, { ips, resolvedAt: this.now() }))
      .catch(() => this.hosts.set(host, { ips: [], resolvedAt: this.now() }))
      .finally(() => this.resolving.delete(host));
  }
}
