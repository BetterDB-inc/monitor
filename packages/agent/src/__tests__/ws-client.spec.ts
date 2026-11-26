import { EventEmitter } from 'events';

const mockSockets: MockSocket[] = [];

class MockSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;

  constructor(
    readonly url?: string,
    readonly options?: { ca?: string[] },
  ) {
    super();
    mockSockets.push(this);
  }

  send(): void {}

  close(_code?: number, _reason?: string): void {}
}

jest.mock('ws', () => ({ __esModule: true, default: MockSocket }));

import { rootCertificates } from 'tls';
import { WsClient } from '../ws-client';

describe('WsClient TLS trust', () => {
  beforeEach(() => {
    mockSockets.length = 0;
  });

  it('adds an extra CA to the bundled roots instead of replacing them', () => {
    new WsClient({ ...buildOptions(), ca: 'PRIVATE-CA-PEM' }).connect();

    const ca = mockSockets[0].options?.ca ?? [];
    expect(ca).toHaveLength(rootCertificates.length + 1);
    expect(ca[ca.length - 1]).toBe('PRIVATE-CA-PEM');
    expect(ca.slice(0, -1)).toEqual([...rootCertificates]);
  });

  it('leaves the trust store alone when no CA is given', () => {
    build().connect();
    expect(mockSockets[0].options?.ca).toBeUndefined();
  });
});

function buildOptions() {
  return {
    url: 'ws://monitor',
    token: 'token',
    onMessage: jest.fn(),
    onOpen: jest.fn(),
    onClose: jest.fn(),
    onError: jest.fn(),
  };
}

function build(): WsClient {
  return new WsClient({
    url: 'ws://monitor',
    token: 'token',
    onMessage: jest.fn(),
    onOpen: jest.fn(),
    onClose: jest.fn(),
    onError: jest.fn(),
  });
}

describe('WsClient reconnects', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSockets.length = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reconnects after a second when the connection drops', () => {
    const client = build();
    client.connect();
    mockSockets[0].emit('open');

    mockSockets[0].emit('close', 1006, Buffer.from(''));
    jest.advanceTimersByTime(1000);

    expect(mockSockets).toHaveLength(2);
    client.close();
  });

  it('connects again after a dropped connection, unlike after close()', () => {
    const client = build();
    client.connect();
    mockSockets[0].emit('open');
    const close = jest.spyOn(mockSockets[0], 'close').mockImplementation((code?: number, reason?: string) => {
      mockSockets[0].emit('close', code, Buffer.from(reason ?? ''));
    });

    client.dropConnection(4000, 'Welcome timeout');
    expect(close).toHaveBeenCalledWith(4000, 'Welcome timeout');
    jest.advanceTimersByTime(1000);

    expect(mockSockets).toHaveLength(2);
    client.close();
  });

  it('waits the longest delay when another agent uses its token', () => {
    const client = build();
    client.connect();
    mockSockets[0].emit('open');

    mockSockets[0].emit('close', 4003, Buffer.from('Another agent is connected with this token'));
    jest.advanceTimersByTime(29_999);
    expect(mockSockets).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(mockSockets).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      '[Agent] Another agent is connected with this token ' +
        '(a duplicate, or a previous instance still shutting down). Retrying in 30 s.',
    );
    expect(error).not.toHaveBeenCalled();
    client.close();
  });

  it('keeps waiting the longest delay while two agents share a token', () => {
    const client = build();
    client.connect();

    for (let i = 0; i < 3; i++) {
      const socket = mockSockets[mockSockets.length - 1];
      socket.emit('open');
      socket.emit('close', 4003, Buffer.from('Another agent is connected with this token'));
      jest.advanceTimersByTime(29_999);
      expect(mockSockets).toHaveLength(i + 1);
      jest.advanceTimersByTime(1);
    }

    expect(mockSockets).toHaveLength(4);
    client.close();
  });
});
