import { connectWithin, NODE_CONNECT_TIMEOUT_MS, NODE_CONNECT_OPTIONS } from '../node-connect';

function stalledClient() {
  return { connect: jest.fn(() => new Promise<void>(() => undefined)), disconnect: jest.fn() };
}

describe('connectWithin', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rejects and disconnects when connect never settles', async () => {
    const client = stalledClient();
    const pending = connectWithin(client, NODE_CONNECT_TIMEOUT_MS);
    const outcome = expect(pending).rejects.toThrow(/timed out/);

    jest.advanceTimersByTime(NODE_CONNECT_TIMEOUT_MS);

    await outcome;
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('resolves when connect succeeds and leaves no timer behind', async () => {
    const client = { connect: jest.fn().mockResolvedValue(undefined), disconnect: jest.fn() };

    await expect(connectWithin(client, NODE_CONNECT_TIMEOUT_MS)).resolves.toBeUndefined();

    expect(jest.getTimerCount()).toBe(0);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('passes a connect rejection through', async () => {
    const client = { connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), disconnect: jest.fn() };

    await expect(connectWithin(client, NODE_CONNECT_TIMEOUT_MS)).rejects.toThrow('ECONNREFUSED');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('NODE_CONNECT_OPTIONS', () => {
  it('never reconnects and bounds the socket connect', () => {
    expect(NODE_CONNECT_OPTIONS.lazyConnect).toBe(true);
    expect(NODE_CONNECT_OPTIONS.retryStrategy()).toBeNull();
    expect(NODE_CONNECT_OPTIONS.connectTimeout).toBe(NODE_CONNECT_TIMEOUT_MS);
  });
});
