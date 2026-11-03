import { hasReplicaLines, isReplicaRole, parseReplicaLines } from './replication-info.parser';

interface LineCase {
  name: string;
  replication: Record<string, string>;
  expected: Record<string, unknown>;
}

describe('parseReplicaLines', () => {
  it.each<LineCase>([
    {
      name: 'Redis 7.x slaveN line',
      replication: {
        role: 'master',
        slave0: 'ip=10.0.0.2,port=6379,state=online,offset=9000,lag=0',
      },
      expected: {
        key: 'slave0',
        index: 0,
        addr: '10.0.0.2:6379',
        state: 'online',
        offset: 9000,
        lagSec: 0,
      },
    },
    {
      name: 'Valkey 8/9 replicaN line',
      replication: {
        role: 'master',
        replica0: 'ip=10.0.0.2,port=6380,state=online,offset=12,lag=1',
      },
      expected: {
        key: 'replica0',
        index: 0,
        addr: '10.0.0.2:6380',
        state: 'online',
        offset: 12,
        lagSec: 1,
      },
    },
    {
      name: 'IPv6 address',
      replication: { slave0: 'ip=::1,port=6379,state=online,offset=5,lag=0' },
      expected: {
        key: 'slave0',
        index: 0,
        addr: '::1:6379',
        state: 'online',
        offset: 5,
        lagSec: 0,
      },
    },
    {
      name: 'line still syncing without lag',
      replication: { slave0: 'ip=10.0.0.2,port=6379,state=wait_bgsave,offset=0' },
      expected: {
        key: 'slave0',
        index: 0,
        addr: '10.0.0.2:6379',
        state: 'wait_bgsave',
        offset: 0,
        lagSec: null,
      },
    },
    {
      name: 'line without ip or port',
      replication: { slave0: 'state=online,offset=7,lag=0' },
      expected: {
        key: 'slave0',
        index: 0,
        addr: null,
        state: 'online',
        offset: 7,
        lagSec: 0,
      },
    },
    {
      name: 'non-numeric offset and lag',
      replication: { slave0: 'ip=10.0.0.2,port=6379,state=online,offset=abc,lag=' },
      expected: {
        key: 'slave0',
        index: 0,
        addr: '10.0.0.2:6379',
        state: 'online',
        offset: null,
        lagSec: null,
      },
    },
    {
      name: 'garbage value',
      replication: { slave0: 'garbage' },
      expected: {
        key: 'slave0',
        index: 0,
        addr: null,
        state: null,
        offset: null,
        lagSec: null,
      },
    },
  ])('parses a $name', ({ replication, expected }) => {
    expect(parseReplicaLines(replication)).toEqual([expect.objectContaining(expected)]);
  });

  it('keeps the raw fields', () => {
    const [line] = parseReplicaLines({
      slave0: 'ip=10.0.0.2,port=6379,state=online,offset=9,lag=0,type=replica',
    });
    expect(line.fields).toEqual({
      ip: '10.0.0.2',
      port: '6379',
      state: 'online',
      offset: '9',
      lag: '0',
      type: 'replica',
    });
  });

  it('orders mixed slaveN and replicaN lines by numeric index', () => {
    const replication = {
      slave10: 'ip=h10,port=1,state=online,offset=1,lag=0',
      replica1: 'ip=h1,port=1,state=online,offset=1,lag=0',
      slave2: 'ip=h2,port=1,state=online,offset=1,lag=0',
    };
    expect(parseReplicaLines(replication).map((l) => l.key)).toEqual([
      'replica1',
      'slave2',
      'slave10',
    ]);
  });

  it('ignores keys that only look like replica lines', () => {
    expect(
      parseReplicaLines({
        role: 'slave',
        slave_repl_offset: '42',
        slave_read_only: '1',
        replica_announced: '1',
        master_link_status: 'up',
        connected_slaves: '0',
      }),
    ).toEqual([]);
  });
});

describe('hasReplicaLines', () => {
  it('is true when any slaveN or replicaN key is present', () => {
    expect(hasReplicaLines({ replica3: 'x' })).toBe(true);
    expect(hasReplicaLines({ slave_repl_offset: '1', connected_slaves: '2' })).toBe(false);
  });
});

describe('isReplicaRole', () => {
  it.each([
    ['slave', true],
    ['replica', true],
    ['active-replica', true],
    ['master', false],
    ['primary', false],
    [undefined, false],
  ])('%s -> %s', (role, expected) => {
    expect(isReplicaRole(role)).toBe(expected);
  });
});
