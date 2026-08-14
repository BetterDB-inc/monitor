import { SentinelNodeInfo } from '@app/common/types/metrics.types';
import {
  detectSentinelDrift,
  isIpLiteral,
  sentinelDriftSignature,
} from '../sentinel-drift-detector';

function node(partial: Partial<SentinelNodeInfo> = {}): SentinelNodeInfo {
  return {
    name: 'mymaster',
    ip: '10.0.0.10',
    port: 6379,
    runid: 'r1',
    flags: ['master'],
    fields: {},
    ...partial,
  };
}

const HOSTNAME_MASTER = node({
  name: 'mymaster',
  ip: 'valkey-0.valkey-headless',
  flags: ['master'],
});

function hostnameReplica(host: string): SentinelNodeInfo {
  return node({
    name: `${host}:6379`,
    ip: host,
    flags: ['slave'],
    masterHost: 'valkey-0.valkey-headless',
    masterPort: 6379,
  });
}

describe('isIpLiteral', () => {
  it('recognises IPv4 and IPv6 literals', () => {
    expect(isIpLiteral('10.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('[2001:db8::1]')).toBe(true);
  });

  it('treats names as names', () => {
    expect(isIpLiteral('valkey-0.valkey-headless')).toBe(false);
    expect(isIpLiteral('localhost')).toBe(false);
    expect(isIpLiteral('')).toBe(false);
  });
});

describe('detectSentinelDrift', () => {
  it('stays silent for a healthy hostname-consistent view', () => {
    const replicas = [hostnameReplica('valkey-1.valkey-headless')];
    expect(detectSentinelDrift(HOSTNAME_MASTER, replicas)).toEqual([]);
  });

  it('stays silent for an all-IP deployment that never announced hostnames', () => {
    const master = node({ ip: '10.0.0.10', flags: ['master'] });
    const replicas = [
      node({
        name: '10.0.0.11:6379',
        ip: '10.0.0.11',
        flags: ['slave'],
        masterHost: '10.0.0.10',
        masterPort: 6379,
      }),
    ];

    expect(detectSentinelDrift(master, replicas)).toEqual([]);
  });

  it('flags the replica carried as a raw IP among hostname peers', () => {
    const replicas = [
      hostnameReplica('valkey-1.valkey-headless'),
      node({
        name: '10.244.3.7:6379',
        ip: '10.244.3.7',
        flags: ['slave'],
        masterHost: 'valkey-0.valkey-headless',
        masterPort: 6379,
      }),
    ];

    const findings = detectSentinelDrift(HOSTNAME_MASTER, replicas);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reason: 'ip_for_hostname',
      endpoint: '10.244.3.7:6379',
      role: 'replica',
      expectedStyle: 'valkey-0.valkey-headless',
    });
  });

  it('flags the master itself when it is the one carried as an IP', () => {
    const master = node({ name: 'mymaster', ip: '10.244.3.1', flags: ['master'] });
    const replicas = [hostnameReplica('valkey-1.valkey-headless')];

    const findings = detectSentinelDrift(master, replicas);
    expect(findings).toHaveLength(1);
    expect(findings[0].role).toBe('master');
  });

  it('detects hostname usage from master-host alone, when every ip has drifted', () => {
    const master = node({ name: 'mymaster', ip: '10.244.3.1', flags: ['master'] });
    const replicas = [
      node({
        name: '10.244.3.7:6379',
        ip: '10.244.3.7',
        flags: ['slave'],
        masterHost: 'valkey-0.valkey-headless',
        masterPort: 6379,
      }),
    ];

    const findings = detectSentinelDrift(master, replicas);
    expect(findings.map((f) => f.endpoint).sort()).toEqual(['10.244.3.1:6379', '10.244.3.7:6379']);
  });

  it('flags a replica configured to follow itself', () => {
    const replicas = [
      node({
        name: 'valkey-1.valkey-headless:6379',
        ip: 'valkey-1.valkey-headless',
        flags: ['slave'],
        masterHost: 'valkey-1.valkey-headless',
        masterPort: 6379,
      }),
    ];

    const findings = detectSentinelDrift(HOSTNAME_MASTER, replicas);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('self_replication');
  });

  it('does not call a replica self-replicating when only the host matches', () => {
    const replicas = [
      node({
        name: 'valkey-1.valkey-headless:6380',
        ip: 'valkey-1.valkey-headless',
        port: 6380,
        flags: ['slave'],
        masterHost: 'valkey-1.valkey-headless',
        masterPort: 6379,
      }),
    ];

    expect(detectSentinelDrift(HOSTNAME_MASTER, replicas)).toEqual([]);
  });

  it('reports both reasons when a drifted node also follows itself', () => {
    const replicas = [
      hostnameReplica('valkey-1.valkey-headless'),
      node({
        name: '10.244.3.7:6379',
        ip: '10.244.3.7',
        flags: ['slave'],
        masterHost: '10.244.3.7',
        masterPort: 6379,
      }),
    ];

    const reasons = detectSentinelDrift(HOSTNAME_MASTER, replicas)
      .map((f) => f.reason)
      .sort();
    // Its own endpoint drifted, it follows a raw IP, and that IP is itself.
    expect(reasons).toEqual(['ip_for_hostname', 'self_replication', 'stale_master_pointer']);
  });

  it('handles a master with no replicas', () => {
    expect(detectSentinelDrift(HOSTNAME_MASTER, [])).toEqual([]);
  });
});

describe('sentinelDriftSignature', () => {
  it('distinguishes the two reasons for one node', () => {
    const replicas = [
      hostnameReplica('valkey-1.valkey-headless'),
      node({
        name: '10.244.3.7:6379',
        ip: '10.244.3.7',
        flags: ['slave'],
        masterHost: '10.244.3.7',
        masterPort: 6379,
      }),
    ];

    const findings = detectSentinelDrift(HOSTNAME_MASTER, replicas);
    const signatures = new Set(findings.map(sentinelDriftSignature));
    expect(signatures.size).toBe(findings.length);
  });

  it('is stable across repeated evaluation', () => {
    const replicas = [
      hostnameReplica('valkey-1.valkey-headless'),
      node({
        name: '10.244.3.7:6379',
        ip: '10.244.3.7',
        flags: ['slave'],
        masterHost: 'valkey-0.valkey-headless',
        masterPort: 6379,
      }),
    ];

    const first = detectSentinelDrift(HOSTNAME_MASTER, replicas).map(sentinelDriftSignature);
    const second = detectSentinelDrift(HOSTNAME_MASTER, replicas).map(sentinelDriftSignature);
    expect(first).toEqual(second);
  });
});

describe('detectSentinelDrift — stale master pointer', () => {
  it('flags a replica pointed at a raw IP among hostname peers', () => {
    const replicas = [
      hostnameReplica('valkey-1.valkey-headless'),
      node({
        name: 'valkey-2.valkey-headless:6379',
        ip: 'valkey-2.valkey-headless',
        flags: ['slave'],
        masterHost: '10.244.3.1',
        masterPort: 6379,
      }),
    ];

    const findings = detectSentinelDrift(HOSTNAME_MASTER, replicas);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reason: 'stale_master_pointer',
      endpoint: '10.244.3.1:6379',
      nodeName: 'valkey-2.valkey-headless:6379',
    });
  });

  it('stays silent when the master pointer is a hostname', () => {
    expect(
      detectSentinelDrift(HOSTNAME_MASTER, [hostnameReplica('valkey-1.valkey-headless')]),
    ).toEqual([]);
  });

  it('stays silent in an all-IP deployment, where a raw pointer is expected', () => {
    const master = node({ ip: '10.0.0.10', flags: ['master'] });
    const replicas = [
      node({
        name: '10.0.0.11:6379',
        ip: '10.0.0.11',
        flags: ['slave'],
        masterHost: '10.0.0.10',
        masterPort: 6379,
      }),
    ];

    expect(detectSentinelDrift(master, replicas)).toEqual([]);
  });
});

describe('detectSentinelDrift — self-replication needs a comparable port', () => {
  it('stays silent when master-port is absent, since host alone proves nothing', () => {
    const replicas = [
      node({
        name: 'valkey-1.valkey-headless:6379',
        ip: 'valkey-1.valkey-headless',
        flags: ['slave'],
        masterHost: 'valkey-1.valkey-headless',
      }),
    ];

    const reasons = detectSentinelDrift(HOSTNAME_MASTER, replicas).map((f) => f.reason);
    expect(reasons).not.toContain('self_replication');
  });
});
