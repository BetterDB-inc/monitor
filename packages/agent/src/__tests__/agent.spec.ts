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
  WsClient: jest.fn(() => ({ connect: jest.fn(), close: jest.fn(), send: jest.fn(), isOpen: jest.fn(() => true) })),
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

describe('Agent.stop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuit.mockResolvedValue(undefined);
  });

  it('disconnects a client whose connect() failed, so it stops retrying', async () => {
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const agent = new Agent({ ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false });

    await expect(agent.start()).rejects.toThrow('ECONNREFUSED');
    // The failed start() already drops the client; stop() disconnects again,
    // which is harmless.
    expect(mockDisconnect).toHaveBeenCalled();
    await agent.stop();

    expect(mockQuit).not.toHaveBeenCalled();
  });

  it('gives up on a node that accepts the connection but never answers, and stop() interrupts the wait', async () => {
    jest.useFakeTimers();
    try {
      mockConnect.mockReturnValueOnce(new Promise(() => {}));
      const silent = new Agent({ ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false });
      const started = silent.start();
      const outcome = expect(started).rejects.toThrow(/connect timed out/);
      await jest.advanceTimersByTimeAsync(15_000);
      await outcome;

      mockConnect.mockReturnValueOnce(new Promise(() => {}));
      const stopping = new Agent({ ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false });
      const pending = stopping.start();
      const stoppedOutcome = expect(pending).rejects.toThrow(/stopped during connect/);
      await stopping.stop();
      await stoppedOutcome;
    } finally {
      jest.useRealTimers();
    }
  });

  it('quits and then disconnects a connected client', async () => {
    mockConnect.mockResolvedValue(undefined);
    const agent = new Agent({ ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false }) as any;
    agent.client = new (Valkey as any)();
    agent.valkeyConnected = true;

    await agent.stop();

    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe('Agent on the cloud side', () => {
  const PASSWORD_CONFIG: AgentConfig = { ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false };
  const identity = { platform: 'openeverest' as const, cluster: 'main', namespace: 'db', instance: 'vk', node: 'n1' };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function wsOf(agent: Agent) {
    return (agent as any).wsClient as { close: jest.Mock; send: jest.Mock; isOpen?: jest.Mock };
  }

  it('gives up on a server that never acknowledges an identified hello, and says so in its status', async () => {
    const agent = new Agent({ ...PASSWORD_CONFIG, identity }) as any;
    agent.onWsOpen();

    await jest.advanceTimersByTimeAsync(14_999);
    expect(agent.getStatus().cloudError).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);

    expect(agent.getStatus().cloudError).toMatch(/too old.*0\.57\.0/);
    expect(wsOf(agent).close).toHaveBeenCalledTimes(1);
  });

  it('is content once the server welcomes the identity', async () => {
    const agent = new Agent({ ...PASSWORD_CONFIG, identity }) as any;
    agent.onWsOpen();
    await agent.onWsMessage(JSON.stringify({ type: 'welcome', serverVersion: '0.57.0', identity: true, readOnly: true }));

    await jest.advanceTimersByTimeAsync(60_000);
    expect(agent.getStatus().cloudError).toBeUndefined();
    expect(wsOf(agent).close).not.toHaveBeenCalled();
  });

  it('treats a welcome that disowns the identity like an old server', async () => {
    const agent = new Agent({ ...PASSWORD_CONFIG, identity }) as any;
    agent.onWsOpen();
    await agent.onWsMessage(JSON.stringify({ type: 'welcome', serverVersion: '0.57.0', identity: false, readOnly: false }));

    expect(agent.getStatus().cloudError).toMatch(/too old/);
    expect(wsOf(agent).close).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a welcome without an identity (classic single-target agents)', async () => {
    const agent = new Agent(PASSWORD_CONFIG) as any;
    agent.onWsOpen();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(agent.getStatus().cloudError).toBeUndefined();
    expect(wsOf(agent).close).not.toHaveBeenCalled();
  });

  it('reports a 4003 close on an identified node as another agent holding it', () => {
    const agent = new Agent({ ...PASSWORD_CONFIG, identity }) as any;
    agent.onWsClose(4003, 'Another agent is connected with this token');
    expect(agent.getStatus().cloudError).toMatch(/another agent already streams this node/);

    const plain = new Agent(PASSWORD_CONFIG) as any;
    plain.onWsClose(4003, 'Another agent is connected with this token');
    expect(plain.getStatus().cloudError).toBeUndefined();
  });
});

describe('Agent Valkey client options', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  it('asks iovalkey for READONLY on a cluster replica, for the polling and the CLI client alike', async () => {
    const agent = new Agent({ ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false, clusterReplica: true }) as any;
    await agent.createValkeyClient('BetterDB-Agent');
    await agent.createValkeyClient('BetterDB-Agent-CLI');

    expect(MockValkey).toHaveBeenCalledTimes(2);
    expect(MockValkey.mock.calls[0][0]).toMatchObject({ readOnly: true, connectionName: 'BetterDB-Agent' });
    expect(MockValkey.mock.calls[1][0]).toMatchObject({ readOnly: true, connectionName: 'BetterDB-Agent-CLI' });
  });

  it('leaves READONLY off for primaries and standalone servers', async () => {
    const agent = new Agent({ ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false }) as any;
    await agent.createValkeyClient('BetterDB-Agent');
    expect(MockValkey.mock.calls[0][0]).toMatchObject({ readOnly: false });
  });
});

describe('Agent CLI client lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockQuit.mockResolvedValue(undefined);
  });

  it('keeps a password-mode CLI client through a close (iovalkey reconnects it) and disconnects it on stop', async () => {
    const agent = new Agent({ ...IAM_CONFIG, authMode: 'password', valkeyPassword: 'p', valkeyTls: false }) as any;
    agent.valkeyConnected = true;
    await agent.getCliExecutor();
    const closeHandler = mockOn.mock.calls.find(([event]) => event === 'close')?.[1] as () => void;

    closeHandler();
    expect(agent.cliClient).not.toBeNull();
    expect(agent.cliExecutor).not.toBeNull();

    await agent.stop();
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('drops an IAM-mode CLI client on close, since it cannot reconnect without a fresh token', async () => {
    const agent = new Agent(IAM_CONFIG) as any;
    await agent.getCliExecutor();
    const closeHandler = mockOn.mock.calls.find(([event]) => event === 'close')?.[1] as () => void;

    closeHandler();

    expect(agent.cliClient).toBeNull();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
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

describe('Agent.onWsOpen - hello', () => {
  beforeEach(() => jest.clearAllMocks());

  function sentHello(config: AgentConfig): any {
    const a = new Agent(config) as any;
    a.wsClient = { send: jest.fn() };
    a.onWsOpen();
    return JSON.parse(a.wsClient.send.mock.calls[0][0]);
  }

  it('reports a serverless target in the valkey block', () => {
    const hello = sentHello({ ...IAM_CONFIG, awsServerless: true });
    expect(hello.valkey.serverless).toBe(true);
  });

  it('reports a non-serverless target as false', () => {
    const hello = sentHello({ ...IAM_CONFIG, awsServerless: false });
    expect(hello.valkey.serverless).toBe(false);
  });

  it('detects a Serverless endpoint from the host in password mode', () => {
    const hello = sentHello({
      ...IAM_CONFIG,
      authMode: 'password',
      valkeyHost: 'my-cache-abc123.serverless.use1.cache.amazonaws.com',
    });
    expect(hello.valkey.serverless).toBe(true);
  });

  it('defaults serverless to false when the flag is unset', () => {
    const hello = sentHello({ ...IAM_CONFIG, authMode: 'password' });
    expect(hello.valkey.serverless).toBe(false);
  });
});
