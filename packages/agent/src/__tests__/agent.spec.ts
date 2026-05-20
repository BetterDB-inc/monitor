// Mock variables must be prefixed "mock" so Jest hoists them alongside jest.mock().
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn();
const mockRemoveAllListeners = jest.fn();
const mockQuit = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();

jest.mock('iovalkey', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    on: mockOn,
    connect: mockConnect,
    disconnect: mockDisconnect,
    removeAllListeners: mockRemoveAllListeners,
    quit: mockQuit,
  })),
}));

jest.mock('../ws-client', () => ({
  WsClient: jest.fn(() => ({ connect: jest.fn(), close: jest.fn(), send: jest.fn() })),
}));

jest.mock('../command-executor', () => ({
  CommandExecutor: jest.fn(),
}));

jest.mock('../auth', () => ({
  ElastiCacheIamProvider: jest.fn(() => ({
    mode: 'elasticache-iam',
    requiresFreshTokenPerConnection: true,
    getToken: jest.fn().mockResolvedValue('fake-iam-token'),
  })),
  PasswordProvider: jest.fn(() => ({
    mode: 'password',
    requiresFreshTokenPerConnection: false,
    getToken: jest.fn().mockResolvedValue(''),
  })),
}));

import Valkey from 'iovalkey';
import { Agent } from '../agent';
import type { AgentConfig } from '../agent';

const MockValkey = Valkey as unknown as jest.Mock;

const IAM_CONFIG: AgentConfig = {
  token: 'tok',
  cloudUrl: 'wss://test',
  valkeyHost: 'localhost',
  valkeyPort: 6379,
  valkeyUsername: 'default',
  valkeyPassword: '',
  valkeyTls: true,
  valkeyDb: 0,
  unsafeMode: false,
  authMode: 'elasticache-iam',
  awsRegion: 'us-east-1',
  awsResourceName: 'my-cluster',
  awsUserId: 'iam-user',
};

describe('Agent.reconnectWithFreshToken', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockQuit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('isReconnecting guard prevents a concurrent second loop', async () => {
    const a = new Agent(IAM_CONFIG) as any;

    const p1 = a.reconnectWithFreshToken();
    const p2 = a.reconnectWithFreshToken(); // bails immediately

    await jest.advanceTimersByTimeAsync(1000);
    await Promise.all([p1, p2]);

    expect(MockValkey).toHaveBeenCalledTimes(1);
  });

  it('reconnectAttempt increments before the delay and resets to 0 on success', async () => {
    const a = new Agent(IAM_CONFIG) as any;

    expect(a.reconnectAttempt).toBe(0);
    const p = a.reconnectWithFreshToken();
    expect(a.reconnectAttempt).toBe(1); // synchronous increment before first await

    await jest.advanceTimersByTimeAsync(1000);
    await p;

    expect(a.reconnectAttempt).toBe(0);
  });

  it('backoff delay grows with each attempt (attempt 1 = 1s, attempt 2 = 2s)', async () => {
    const a = new Agent(IAM_CONFIG) as any;

    // Fail attempt 1 so reconnectAttempt naturally reaches 2 for the retry.
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const p1 = a.reconnectWithFreshToken();
    await jest.advanceTimersByTimeAsync(999);
    expect(MockValkey).not.toHaveBeenCalled(); // still waiting for 1000ms delay
    await jest.advanceTimersByTimeAsync(1);
    await p1; // attempt 1 fails; retry is scheduled on reconnectLoopPromise

    // Retry has reconnectAttempt=2, delay=2000ms.
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    await jest.advanceTimersByTimeAsync(1999);
    expect(MockValkey).not.toHaveBeenCalled(); // still waiting for 2000ms delay
    await jest.advanceTimersByTimeAsync(1);
    await a.reconnectLoopPromise;
    expect(MockValkey).toHaveBeenCalledTimes(1);
  });

  it('shuttingDown set during connect causes the new client to be quit', async () => {
    const a = new Agent(IAM_CONFIG) as any;

    mockConnect.mockImplementationOnce(async () => {
      a.shuttingDown = true;
    });

    const p = a.reconnectWithFreshToken();
    await jest.advanceTimersByTimeAsync(1000);
    await p;

    expect(mockQuit).toHaveBeenCalled();
    expect(a.isReconnecting).toBe(false);
  });

  it('retries after connect() failure: a second Valkey client is created', async () => {
    const a = new Agent(IAM_CONFIG) as any;

    // First connect fails, second succeeds.
    mockConnect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(undefined);

    const p = a.reconnectWithFreshToken();
    await jest.advanceTimersByTimeAsync(1000); // drain attempt-1 delay
    await p;                                   // attempt 1 finishes (fails), retry scheduled

    // Advance past the retry's delay (attempt 2 = 2000ms) then await the
    // reconnectLoopPromise so all async work in the second attempt has settled.
    await jest.advanceTimersByTimeAsync(2000);
    await a.reconnectLoopPromise;

    // Two Valkey clients were created: one per attempt.
    expect(MockValkey).toHaveBeenCalledTimes(2);
  });
});

describe('Agent.createValkeyClient - retryStrategy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses null retryStrategy for IAM mode (fresh client per connection)', async () => {
    const a = new Agent(IAM_CONFIG) as any;
    await a.createValkeyClient('test');

    const { retryStrategy } = MockValkey.mock.calls[0][0];
    expect(retryStrategy()).toBeNull();
  });

  it('uses exponential retryStrategy for password mode', async () => {
    const pwConfig: AgentConfig = { ...IAM_CONFIG, authMode: 'password' };
    const a = new Agent(pwConfig) as any;
    await a.createValkeyClient('test');

    const { retryStrategy } = MockValkey.mock.calls[0][0];
    expect(retryStrategy(1)).toBe(1000);
    expect(retryStrategy(2)).toBe(2000);
    expect(retryStrategy(100)).toBe(30000); // capped
  });
});
