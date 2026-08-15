import { probeSourceFunctionsClusterAware } from '../function-presence';

// Capture constructed clients so each master can be given its own FUNCTION LIST reply.
const constructed: Array<{ host: string; port: number; call: jest.Mock; connect: jest.Mock; quit: jest.Mock }> = [];
let callReplies: Record<string, unknown[]>; // keyed by `${host}:${port}` -> FUNCTION LIST result

jest.mock('iovalkey', () => {
  return jest.fn().mockImplementation((opts: { host: string; port: number }) => {
    const key = `${opts.host}:${opts.port}`;
    const client = {
      host: opts.host,
      port: opts.port,
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      call: jest.fn().mockImplementation(async () => callReplies[key] ?? []),
    };
    constructed.push(client);
    return client;
  });
});

function makeAdapter(nodes: Array<{ flags: string[]; address?: string }>, seedReply: unknown[] = []) {
  return {
    getClient: jest.fn().mockReturnValue({ call: jest.fn().mockResolvedValue(seedReply) }),
    getClusterNodes: jest.fn().mockResolvedValue(nodes),
  };
}

describe('probeSourceFunctionsClusterAware', () => {
  beforeEach(() => {
    constructed.length = 0;
    callReplies = {};
  });

  it('probes only the seed connection when the source is standalone', async () => {
    const adapter = makeAdapter([], [['library_name', 'lib']]);
    const presence = await probeSourceFunctionsClusterAware(adapter, {}, false);
    expect(presence).toBe('present');
    expect(adapter.getClusterNodes).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(0); // no per-master clients created
  });

  it('finds a library that lives only on a non-seed master', async () => {
    const nodes = [
      { flags: ['master'], address: '10.0.0.1:6379@16379' },
      { flags: ['master'], address: '10.0.0.2:6379@16379' },
      { flags: ['slave'], address: '10.0.0.3:6379@16379' },
    ];
    callReplies = { '10.0.0.1:6379': [], '10.0.0.2:6379': [['library_name', 'lib']] };
    const presence = await probeSourceFunctionsClusterAware(makeAdapter(nodes), {}, true);
    expect(presence).toBe('present');
    // Only the two masters are probed, not the replica.
    expect(constructed.map((c) => c.port === 6379 && c.host)).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it("is 'absent' only when every master answers with no functions", async () => {
    const nodes = [
      { flags: ['master'], address: '10.0.0.1:6379@16379' },
      { flags: ['master'], address: '10.0.0.2:6379@16379' },
    ];
    callReplies = { '10.0.0.1:6379': [], '10.0.0.2:6379': [] };
    expect(await probeSourceFunctionsClusterAware(makeAdapter(nodes), {}, true)).toBe('absent');
  });

  it("is 'unknown' when a master probe fails and none reports present", async () => {
    const nodes = [
      { flags: ['master'], address: '10.0.0.1:6379@16379' },
      { flags: ['master'], address: '10.0.0.2:6379@16379' },
    ];
    callReplies = { '10.0.0.1:6379': [] };
    // 10.0.0.2 has no reply configured -> resolves []; force a throw instead:
    const adapter = makeAdapter(nodes);
    // Second constructed client throws on call.
    const iovalkey = jest.requireMock('iovalkey') as jest.Mock;
    iovalkey.mockImplementationOnce((opts: { host: string; port: number }) => {
      const client = { host: opts.host, port: opts.port, connect: jest.fn().mockResolvedValue(undefined), quit: jest.fn().mockResolvedValue(undefined), call: jest.fn().mockResolvedValue([]) };
      constructed.push(client);
      return client;
    }).mockImplementationOnce((opts: { host: string; port: number }) => {
      const client = { host: opts.host, port: opts.port, connect: jest.fn().mockRejectedValue(new Error('Connection is closed.')), quit: jest.fn().mockResolvedValue(undefined), call: jest.fn() };
      constructed.push(client);
      return client;
    });
    expect(await probeSourceFunctionsClusterAware(adapter, {}, true)).toBe('unknown');
  });

  it('falls back to the seed when masters cannot be enumerated', async () => {
    const adapter = {
      getClient: jest.fn().mockReturnValue({ call: jest.fn().mockResolvedValue([['library_name', 'lib']]) }),
      getClusterNodes: jest.fn().mockResolvedValue([]), // no masters discovered
    };
    expect(await probeSourceFunctionsClusterAware(adapter, {}, true)).toBe('present');
  });
});
