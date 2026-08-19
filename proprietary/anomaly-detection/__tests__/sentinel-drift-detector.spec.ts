import { SentinelNodeInfo } from '@app/common/types/metrics.types';
import { MetricsParser } from '@app/database/parsers/metrics.parser';
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

  it('stays silent when every ip has drifted, since nothing says hostnames were used', () => {
    // master-host is the replica's REPLICAOF target from INFO, not an address
    // Sentinel resolved, so a DNS-based replicaof is not evidence of
    // announcement. A fully-drifted group is indistinguishable from one that
    // never used hostnames — silence is the honest answer.
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

    expect(detectSentinelDrift(master, replicas)).toEqual([]);
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

describe('detectSentinelDrift — unknown-primary placeholder', () => {
  it('does not read Sentinel\'s "?" placeholder as hostname announcement', () => {
    // Sentinel writes ? when a replica's primary is not yet known. Counting it as
    // a hostname would classify an all-IP deployment as mixed and alert every
    // member of it.
    const master = node({ ip: '10.0.0.10', flags: ['master'] });
    const replicas = [
      node({
        name: '10.0.0.11:6379',
        ip: '10.0.0.11',
        flags: ['slave'],
        masterHost: '?',
        masterPort: 0,
      }),
      node({
        name: '10.0.0.12:6379',
        ip: '10.0.0.12',
        flags: ['slave'],
        masterHost: '10.0.0.10',
        masterPort: 6379,
      }),
    ];

    expect(detectSentinelDrift(master, replicas)).toEqual([]);
  });

  it('still fires when a real hostname is present alongside a placeholder', () => {
    const replicas = [
      hostnameReplica('valkey-1.valkey-headless'),
      node({
        name: '10.244.3.7:6379',
        ip: '10.244.3.7',
        flags: ['slave'],
        masterHost: '?',
        masterPort: 0,
      }),
    ];

    const findings = detectSentinelDrift(HOSTNAME_MASTER, replicas);
    expect(findings.map((f) => f.reason)).toEqual(['ip_for_hostname']);
  });
});

// ─── End-to-end: raw reply → real parser → detector ──────────────────────────
//
// Every other test in this file and in anomaly.service.spec hand-builds
// SentinelNodeInfo or mocks getSentinelMasters/getSentinelReplicas, so
// MetricsParser.parseSentinelNodes never actually runs on the detector's behalf.
// If the parser returned [] the detector would go quiet with no error and both
// PRs would stay green while the feature did nothing. These cases wire the real
// parser to the real detector so that whole path is exercised.
//
// NB this pins the parser to the reply SHAPE (flat key/value arrays, one per
// entry) and to the field NAMES as modelled. It does not substitute for running
// against a live Sentinel — if upstream names a field differently, this test is
// wrong in the same direction as the parser.
describe('raw SENTINEL reply through the real parser into the detector', () => {
  const master = [
    'name',
    'mymaster',
    'ip',
    'valkey-0.valkey-headless',
    'port',
    '6379',
    'runid',
    'a1b2c3',
    'flags',
    'master',
  ];
  const healthyReplica = [
    'name',
    'valkey-1.valkey-headless:6379',
    'ip',
    'valkey-1.valkey-headless',
    'port',
    '6379',
    'runid',
    'd4e5f6',
    'flags',
    'slave',
    'master-host',
    'valkey-0.valkey-headless',
    'master-port',
    '6379',
  ];
  const driftedReplica = [
    'name',
    '10.244.3.7:6379',
    'ip',
    '10.244.3.7',
    'port',
    '6379',
    'runid',
    '778899',
    'flags',
    'slave',
    'master-host',
    'valkey-0.valkey-headless',
    'master-port',
    '6379',
  ];

  it('parses a real-shaped reply into nodes the detector understands', () => {
    const [parsedMaster] = MetricsParser.parseSentinelNodes([master]);
    expect(parsedMaster).toMatchObject({
      name: 'mymaster',
      ip: 'valkey-0.valkey-headless',
      port: 6379,
      flags: ['master'],
    });

    const replicas = MetricsParser.parseSentinelNodes([healthyReplica, driftedReplica]);
    expect(replicas).toHaveLength(2);
    expect(replicas[1].masterHost).toBe('valkey-0.valkey-headless');
    expect(replicas[1].masterPort).toBe(6379);
  });

  it('flags the IP-for-hostname replica end to end', () => {
    const [parsedMaster] = MetricsParser.parseSentinelNodes([master]);
    const replicas = MetricsParser.parseSentinelNodes([healthyReplica, driftedReplica]);

    const findings = detectSentinelDrift(parsedMaster, replicas);

    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('ip_for_hostname');
    expect(findings[0].endpoint).toContain('10.244.3.7');
  });

  it('stays silent end to end on a hostname-consistent group', () => {
    const [parsedMaster] = MetricsParser.parseSentinelNodes([master]);
    const replicas = MetricsParser.parseSentinelNodes([healthyReplica]);

    expect(detectSentinelDrift(parsedMaster, replicas)).toEqual([]);
  });
});
