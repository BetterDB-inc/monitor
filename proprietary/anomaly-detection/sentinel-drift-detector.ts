import { SentinelNodeInfo } from '@app/common/types/metrics.types';

/**
 * Sentinel endpoint drift (valkey-io/valkey#2158).
 *
 * Sentinel records the *resolved* address of a node rather than the hostname it
 * was configured with. In Kubernetes a replica's ephemeral pod IP therefore
 * leaks into Sentinel's view in place of the stable announced hostname, and once
 * the pod is rescheduled that recorded IP is stale: Sentinel and every client it
 * steers now point at a dead or wrong address. One report on the same issue also
 * shows a node ending up configured as a replica of itself.
 *
 * Unresolved upstream with no maintainer fix landed, and reproducible — a
 * durable hazard.
 *
 * ## The signal is a MIXED group, not "an IP is present"
 *
 * Sentinel normally stores IPs; a deployment that does not use hostname
 * announcement is entirely IP-based and perfectly healthy. A deployment that
 * DOES announce hostnames shows hostnames throughout. The fault is the mixture:
 * a group where hostnames are clearly in use, yet one member is carried as a raw
 * IP. That member is the one whose announcement was lost.
 *
 * Firing on "any raw IP" would alert on every IP-based Sentinel deployment in
 * existence, so the hostname-in-use test comes first and nothing is reported
 * without it.
 */

export type SentinelDriftReason = 'ip_for_hostname' | 'stale_master_pointer' | 'self_replication';

export interface SentinelDrift {
  reason: SentinelDriftReason;
  /** Master name whose view this finding belongs to. */
  masterName: string;
  /** The affected node's endpoint as Sentinel currently records it. */
  endpoint: string;
  /** Sentinel's `name` for the affected entry. */
  nodeName: string;
  /** Role as Sentinel reports it, for message context. */
  role: 'master' | 'replica';
  /**
   * A hostname observed elsewhere in the same group, showing what the affected
   * node's endpoint should have looked like. Empty for self-replication.
   */
  expectedStyle: string;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Whether a host is a raw IP literal rather than a name. IPv6 is recognised by
 * its colons, which a hostname never contains.
 */
export function isIpLiteral(host: string): boolean {
  const value = (host ?? '').trim().replace(/^\[/, '').replace(/\]$/, '');
  if (value === '') {
    return false;
  }
  if (value.includes(':')) {
    return true;
  }
  return IPV4.test(value);
}

/**
 * Whether a value is a usable HOSTNAME, as opposed to an IP literal or a
 * placeholder.
 *
 * Sentinel writes `?` when it does not yet know a replica's primary — the node
 * has not been INFOed, or is unreachable. Treating that as a hostname would
 * classify an entirely IP-based deployment as "announcing hostnames" and alert
 * every one of its members: precisely the false positive the mixed-group
 * guardrail exists to prevent. A real hostname contains at least one letter.
 */
function isHostname(value: string): boolean {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed === '?') {
    return false;
  }
  if (isIpLiteral(trimmed)) {
    return false;
  }
  return /[a-z]/i.test(trimmed);
}

function endpointOf(node: SentinelNodeInfo): string {
  return `${node.ip}:${node.port}`;
}

/**
 * True when Sentinel itself is recording members under hostnames.
 *
 * Only Sentinel's OWN `ip` field counts. `master-host` is the replica's
 * `REPLICAOF` target as reported by its INFO, not an address Sentinel resolved —
 * an ordinary IP-based Sentinel whose replicas were pointed at the primary by DNS
 * carries a hostname there, and treating that as announcement would classify the
 * whole deployment as mixed and alert every member.
 *
 * The cost of the narrower signal is that a group where EVERY address has already
 * drifted to a raw IP is indistinguishable from one that never used hostnames.
 * Silence is the right answer there: nothing in the view says otherwise.
 */
function hostnamesInUse(master: SentinelNodeInfo, replicas: SentinelNodeInfo[]): boolean {
  for (const member of [master, ...replicas]) {
    if (isHostname(member.ip)) {
      return true;
    }
  }
  return false;
}

/** The first hostname visible in the group, used to show the expected shape. */
function sampleHostname(master: SentinelNodeInfo, replicas: SentinelNodeInfo[]): string {
  for (const member of [master, ...replicas]) {
    if (isHostname(member.ip)) {
      return member.ip;
    }
  }
  return '';
}

/**
 * A replica configured to follow itself: its `master-host`/`master-port` point at
 * its own endpoint. Compared on host AND port so two nodes sharing a host but
 * listening on different ports are not confused for one another.
 *
 * An absent or unparseable `master-port` makes that comparison impossible, and a
 * host match alone is not evidence — co-locating two instances on one host at
 * different ports is an ordinary small deployment. Without the port this stays
 * silent rather than raising a CRITICAL it cannot substantiate.
 */
function isSelfReplicating(replica: SentinelNodeInfo): boolean {
  if (replica.masterHost === undefined || replica.masterHost === '') {
    return false;
  }
  if (replica.masterPort === undefined || replica.masterPort !== replica.port) {
    return false;
  }
  return replica.masterHost === replica.ip;
}

/**
 * Findings for one monitored master and the replicas Sentinel believes follow it.
 * Pure: the caller supplies the Sentinel view and applies any persistence gate.
 */
export function detectSentinelDrift(
  master: SentinelNodeInfo,
  replicas: SentinelNodeInfo[],
): SentinelDrift[] {
  const findings: SentinelDrift[] = [];
  const masterName = master.name;

  for (const replica of replicas) {
    if (!isSelfReplicating(replica)) {
      continue;
    }
    findings.push({
      reason: 'self_replication',
      masterName,
      endpoint: endpointOf(replica),
      nodeName: replica.name,
      role: 'replica',
      expectedStyle: '',
    });
  }

  if (!hostnamesInUse(master, replicas)) {
    return findings;
  }

  const expectedStyle = sampleHostname(master, replicas);
  const candidates: Array<{ node: SentinelNodeInfo; role: 'master' | 'replica' }> = [
    { node: master, role: 'master' },
    ...replicas.map((replica) => {
      return { node: replica, role: 'replica' as const };
    }),
  ];

  for (const { node, role } of candidates) {
    if (node.ip === '' || !isIpLiteral(node.ip)) {
      continue;
    }
    findings.push({
      reason: 'ip_for_hostname',
      masterName,
      endpoint: endpointOf(node),
      nodeName: node.name,
      role,
      expectedStyle,
    });
  }

  // The replica's own address is not the only endpoint Sentinel records. Its
  // `master-host` is what a REPLICAOF is pointed at, so a raw IP there goes stale
  // exactly the same way — and this is the field that decides where replication
  // traffic goes after a restart.
  for (const replica of replicas) {
    if (replica.masterHost === undefined || replica.masterHost === '') {
      continue;
    }
    if (!isIpLiteral(replica.masterHost)) {
      continue;
    }
    findings.push({
      reason: 'stale_master_pointer',
      masterName,
      // Port omitted when Sentinel did not report one, rather than borrowing the
      // master's — an invented port in the message and the signature would be
      // worse than an honest host-only endpoint.
      endpoint:
        replica.masterPort === undefined
          ? replica.masterHost
          : `${replica.masterHost}:${replica.masterPort}`,
      nodeName: replica.name,
      role: 'replica',
      expectedStyle,
    });
  }

  return findings;
}

/**
 * Stable signature for a finding, so a drift dedupes across polls while a change
 * of node, endpoint, or reason alerts again.
 */
export function sentinelDriftSignature(drift: SentinelDrift): string {
  return `${drift.reason}|${drift.masterName}|${drift.nodeName}|${drift.endpoint}`;
}
