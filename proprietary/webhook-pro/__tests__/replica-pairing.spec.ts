import { ReplicaPairing } from '../replica-pairing';

const primaryInfo = (replid: string, ...addrs: string[]) => ({
  role: 'master',
  master_replid: replid,
  ...Object.fromEntries(
    addrs.map((addr, i) => {
      const [ip, port] = addr.split(':');
      return [`slave${i}`, `ip=${ip},port=${port},state=online,offset=100,lag=0`];
    }),
  ),
});

const replicaInfo = (replid: string) => ({ role: 'slave', master_replid: replid });

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ReplicaPairing', () => {
  it('pairs a replica by its address on the primary', () => {
    const pairing = new ReplicaPairing(jest.fn());
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379', '10.0.0.3:6379'), {
      host: '10.0.0.1',
      port: 6379,
    });
    pairing.observe('a', replicaInfo('r1'), { host: '10.0.0.3', port: 6379 });

    expect(pairing.primaryFor('a')).toEqual({
      primaryConnectionId: 'p',
      replicaAddr: '10.0.0.3:6379',
    });
    expect(pairing.replicaConnectionFor('p', '10.0.0.3:6379')).toBe('a');
    expect(pairing.replicaConnectionFor('p', '10.0.0.2:6379')).toBeNull();
  });

  it('pairs a unique replid and port when the host cannot be resolved', async () => {
    const resolver = jest.fn().mockRejectedValue(new Error('no dns'));
    const pairing = new ReplicaPairing(resolver);
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6380'), { host: 'primary', port: 6379 });
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6380 });
    await flush();

    expect(pairing.primaryFor('a')?.replicaAddr).toBe('10.0.0.2:6380');
  });

  it('does not pair by port when the replica IP is not on the primary', () => {
    const pairing = new ReplicaPairing(jest.fn());
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379'), { host: '10.0.0.1', port: 6379 });
    pairing.observe('chained', replicaInfo('r1'), { host: '10.0.0.3', port: 6379 });

    expect(pairing.primaryFor('chained')).toBeNull();
    expect(pairing.replicaConnectionFor('p', '10.0.0.2:6379')).toBeNull();
  });

  it('does not pair by port when the host resolved to another address', async () => {
    const pairing = new ReplicaPairing(jest.fn(async () => ['172.17.0.5']));
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379'), { host: '10.0.0.1', port: 6379 });
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6379 });
    await flush();

    expect(pairing.primaryFor('a')).toBeNull();
  });

  it('pairs in neither direction when the primary is monitored twice', () => {
    const pairing = new ReplicaPairing(jest.fn());
    pairing.observe('p-ip', primaryInfo('r1', '10.0.0.2:6379'), { host: '10.0.0.1', port: 6379 });
    pairing.observe('p-name', primaryInfo('r1', '10.0.0.2:6379'), {
      host: 'primary.svc',
      port: 6379,
    });
    pairing.observe('a', replicaInfo('r1'), { host: '10.0.0.2', port: 6379 });

    expect(pairing.primaryFor('a')).toBeNull();
    expect(pairing.replicaConnectionFor('p-ip', '10.0.0.2:6379')).toBeNull();
    expect(pairing.replicaConnectionFor('p-name', '10.0.0.2:6379')).toBeNull();
  });

  it('pairs an active-replica', () => {
    const pairing = new ReplicaPairing(jest.fn());
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379'), { host: '10.0.0.1', port: 6379 });
    pairing.observe('a', { role: 'active-replica', master_replid: 'r1' }, {
      host: '10.0.0.2',
      port: 6379,
    });

    expect(pairing.replicaConnectionFor('p', '10.0.0.2:6379')).toBe('a');
  });

  it('drops the cached host lookup when its connection is forgotten', async () => {
    const resolver = jest.fn(async () => ['10.0.0.2']);
    const pairing = new ReplicaPairing(resolver);
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6379 });
    await flush();
    pairing.forget('a');
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6379 });

    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('pairs by the resolved host when several replicas share a port', async () => {
    const resolver = jest.fn(async (host: string) =>
      host === 'replica-b.svc' ? ['10.0.0.3'] : ['10.0.0.2'],
    );
    const pairing = new ReplicaPairing(resolver);
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379', '10.0.0.3:6379'), {
      host: 'primary',
      port: 6379,
    });
    pairing.observe('a', replicaInfo('r1'), { host: 'replica-a.svc', port: 6379 });
    pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
    expect(pairing.primaryFor('b')).toBeNull();

    await flush();

    expect(pairing.primaryFor('b')?.replicaAddr).toBe('10.0.0.3:6379');
    expect(pairing.replicaConnectionFor('p', '10.0.0.2:6379')).toBe('a');
  });

  it('does not pair when several replicas share a port and the host is unknown', async () => {
    const pairing = new ReplicaPairing(jest.fn().mockRejectedValue(new Error('no dns')));
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379', '10.0.0.3:6379'), {
      host: 'primary',
      port: 6379,
    });
    pairing.observe('a', replicaInfo('r1'), { host: 'replica-a.svc', port: 6379 });
    await flush();

    expect(pairing.primaryFor('a')).toBeNull();
  });

  it('retries a failed host lookup after a short delay', async () => {
    let now = 0;
    const resolver = jest
      .fn()
      .mockRejectedValueOnce(new Error('no dns'))
      .mockResolvedValue(['10.0.0.3']);
    const pairing = new ReplicaPairing(resolver, () => now);
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379', '10.0.0.3:6379'), {
      host: 'primary',
      port: 6379,
    });
    pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
    await flush();
    pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
    expect(resolver).toHaveBeenCalledTimes(1);

    now = 31_000;
    pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
    await flush();

    expect(pairing.primaryFor('b')?.replicaAddr).toBe('10.0.0.3:6379');
  });

  it('gives up on a host lookup that never settles', async () => {
    jest.useFakeTimers();
    try {
      const resolver = jest.fn(() => new Promise<string[]>(() => undefined));
      let now = 0;
      const pairing = new ReplicaPairing(resolver, () => now);
      pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
      await jest.advanceTimersByTimeAsync(5_000);

      now = 31_000;
      pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });

      expect(resolver).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('backs off after repeated failed lookups', async () => {
    let now = 0;
    const resolver = jest.fn().mockRejectedValue(new Error('no dns'));
    const pairing = new ReplicaPairing(resolver, () => now);
    const observe = async (at: number) => {
      now = at;
      pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
      await flush();
    };

    await observe(0);
    await observe(31_000);
    await observe(62_000);
    expect(resolver).toHaveBeenCalledTimes(2);

    await observe(92_000);
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('stops pairing by old IPs once a refresh fails', async () => {
    let now = 0;
    const resolver = jest
      .fn()
      .mockResolvedValueOnce(['10.0.0.3'])
      .mockRejectedValue(new Error('no dns'));
    const pairing = new ReplicaPairing(resolver, () => now);
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379', '10.0.0.3:6379'), {
      host: 'primary',
      port: 6379,
    });
    pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
    await flush();
    expect(pairing.primaryFor('b')?.replicaAddr).toBe('10.0.0.3:6379');

    now = 6 * 60_000;
    pairing.observe('b', replicaInfo('r1'), { host: 'replica-b.svc', port: 6379 });
    await flush();

    expect(pairing.primaryFor('b')).toBeNull();
  });

  it('does not pair a replica of a different primary', () => {
    const pairing = new ReplicaPairing(jest.fn());
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379'), { host: '10.0.0.1', port: 6379 });
    pairing.observe('a', replicaInfo('r2'), { host: '10.0.0.2', port: 6379 });

    expect(pairing.primaryFor('a')).toBeNull();
    expect(pairing.replicaConnectionFor('p', '10.0.0.2:6379')).toBeNull();
  });

  it('forgets a connection that stops reporting a role', () => {
    const pairing = new ReplicaPairing(jest.fn());
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379'), { host: '10.0.0.1', port: 6379 });
    pairing.observe('a', replicaInfo('r1'), { host: '10.0.0.2', port: 6379 });
    pairing.observe('a', undefined, { host: '10.0.0.2', port: 6379 });

    expect(pairing.replicaConnectionFor('p', '10.0.0.2:6379')).toBeNull();
  });

  it('keeps the cached host lookup through a poll without a role', async () => {
    const resolver = jest.fn(async () => ['10.0.0.2']);
    const pairing = new ReplicaPairing(resolver);
    pairing.observe('p', primaryInfo('r1', '10.0.0.2:6379'), { host: '10.0.0.1', port: 6379 });
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6379 });
    await flush();
    pairing.observe('a', undefined, { host: 'replica.svc', port: 6379 });
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6379 });

    expect(pairing.primaryFor('a')?.replicaAddr).toBe('10.0.0.2:6379');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('drops a lookup that settles after its connection is forgotten', async () => {
    let settle: (ips: string[]) => void = () => undefined;
    const resolver = jest
      .fn()
      .mockImplementationOnce(() => new Promise<string[]>((resolve) => (settle = resolve)))
      .mockResolvedValue(['10.0.0.2']);
    const pairing = new ReplicaPairing(resolver);
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6379 });
    pairing.forget('a');
    settle(['10.0.0.9']);
    await flush();
    pairing.observe('a', replicaInfo('r1'), { host: 'replica.svc', port: 6379 });

    expect(resolver).toHaveBeenCalledTimes(2);
  });
});
