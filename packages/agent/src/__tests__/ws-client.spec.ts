import { EventEmitter } from 'events';

const mockSockets: MockSocket[] = [];

class MockSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;

  constructor() {
    super();
    mockSockets.push(this);
  }

  send(): void {}

  close(): void {}
}

jest.mock('ws', () => ({ __esModule: true, default: MockSocket }));

import { WsClient } from '../ws-client';

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
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockSockets.length = 0;
    jest.spyOn(console, 'log').mockImplementation(() => {});
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

  it('waits the longest delay when another agent uses its token', () => {
    const client = build();
    client.connect();
    mockSockets[0].emit('open');

    mockSockets[0].emit('close', 4003, Buffer.from('Another agent is connected with this token'));
    jest.advanceTimersByTime(29_999);
    expect(mockSockets).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(mockSockets).toHaveLength(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Another agent is using the same token'));
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
