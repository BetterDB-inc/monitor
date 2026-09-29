import { QUIT_TIMEOUT_MS, UnifiedDatabaseAdapter } from './unified.adapter';

// getInfo is exercised in isolation with a mocked client. Object.create bypasses
// the real constructor (which would open a live Valkey connection).
function makeAdapter(infoImpl: (section?: string) => string) {
  const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
  const info = jest.fn((section?: string) => Promise.resolve(infoImpl(section)));
  // `client` is a getter over `_client`; set the backing field.
  (adapter as unknown as { _client: { info: typeof info } })._client = { info };
  return { adapter, info };
}

describe('UnifiedDatabaseAdapter.getInfo — Redis 6 / KeyDB compatibility', () => {
  it('fetches each section with its own single-section INFO (never multi-arg)', async () => {
    const { adapter, info } = makeAdapter((s) => `# ${s}\r\n${s}_field:1\r\n`);

    await adapter.getInfo(['keyspace', 'memory', 'cluster']);

    // One call per section — NOT one multi-section call.
    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenNthCalledWith(1, 'keyspace');
    expect(info).toHaveBeenNthCalledWith(2, 'memory');
    expect(info).toHaveBeenNthCalledWith(3, 'cluster');
    // Multi-arg INFO is the Redis-7-only syntax KeyDB/Redis<7 reject with
    // "ERR syntax error" — assert we never emit it.
    for (const call of info.mock.calls) {
      expect(call.length).toBeLessThanOrEqual(1);
    }
  });

  it('merges the requested sections into one parsed result', async () => {
    const { adapter } = makeAdapter((s) => `# ${s}\r\n${s}_ok:1\r\n`);

    const result = await adapter.getInfo(['keyspace', 'memory']);

    expect(result).toHaveProperty('keyspace');
    expect(result).toHaveProperty('memory');
  });

  it('uses a single-section INFO for exactly one section (unchanged behavior)', async () => {
    const { adapter, info } = makeAdapter((s) => `# ${s}\r\n`);

    await adapter.getInfo(['memory']);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('memory');
  });

  it('uses full INFO (no args) when no sections are requested (unchanged behavior)', async () => {
    const { adapter, info } = makeAdapter(() => `# Server\r\nredis_version:7.0.0\r\n`);

    await adapter.getInfo();

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith();
  });
});

describe('UnifiedDatabaseAdapter.getCapabilities — sentinel detection', () => {
  function makeSentinelAdapter(serverMode: string) {
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const info = jest.fn((section?: string) =>
      Promise.resolve(
        section === 'server'
          ? `# Server\r\nredis_version:7.0.0\r\nserver_mode:${serverMode}\r\n`
          : `# ${section}\r\n`,
      ),
    );
    const config = jest.fn(() => Promise.resolve(['maxmemory', '0']));
    const call = jest.fn(() => Promise.resolve(['idx']));
    (
      adapter as unknown as {
        _client: { info: typeof info; config: typeof config; call: typeof call };
      }
    )._client = { info, config, call };
    return { adapter, info, config, call };
  }

  it('marks a sentinel INFO as isSentinel and skips CONFIG/FT._LIST probes', async () => {
    const { adapter, config, call } = makeSentinelAdapter('sentinel');

    await (adapter as unknown as { detectCapabilities(): Promise<void> }).detectCapabilities();
    const capabilities = adapter.getCapabilities();

    expect(capabilities.isSentinel).toBe(true);
    expect(capabilities.clusterEnabled).toBe(false);
    expect(capabilities.hasConfig).toBe(false);
    expect(capabilities.hasVectorSearch).toBe(false);
    expect(capabilities.hasAclLog).toBe(true);
    expect(config).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('marks a standalone INFO as isSentinel: false', async () => {
    const { adapter } = makeSentinelAdapter('standalone');

    await (adapter as unknown as { detectCapabilities(): Promise<void> }).detectCapabilities();
    const capabilities = adapter.getCapabilities();

    expect(capabilities.isSentinel).toBe(false);
  });
});

describe('UnifiedDatabaseAdapter.disconnect', () => {
  it('closes the socket when QUIT gets no answer', async () => {
    jest.useFakeTimers();
    try {
      const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
      const client = { quit: jest.fn(() => new Promise(() => undefined)), disconnect: jest.fn() };
      (adapter as unknown as { _client: typeof client })._client = client;
      const pending = adapter.disconnect();
      await jest.advanceTimersByTimeAsync(QUIT_TIMEOUT_MS);
      await pending;
      expect(client.disconnect).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not force-close after a clean QUIT', async () => {
    const adapter = Object.create(UnifiedDatabaseAdapter.prototype) as UnifiedDatabaseAdapter;
    const client = { quit: jest.fn().mockResolvedValue('OK'), disconnect: jest.fn() };
    (adapter as unknown as { _client: typeof client })._client = client;
    await adapter.disconnect();
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});

describe('UnifiedDatabaseAdapter.getInfoParsed', () => {
  it('parses raw INFO keyspace lines into typed objects (issue #360)', async () => {
    const { adapter } = makeAdapter(
      () =>
        `# Stats\r\nkeyspace_hits:42\r\n\r\n# Keyspace\r\ndb0:keys=568,expires=310,avg_ttl=7510966104\r\n`,
    );

    const result = await adapter.getInfoParsed();

    expect(result.keyspace).toEqual({
      db0: { keys: 568, expires: 310, avg_ttl: 7510966104 },
    });
    // Scalar sections stay strings.
    expect(result.stats?.keyspace_hits).toBe('42');
  });
});
