import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { createUpgradeRouter } from './upgrade-router';

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const HOST = 'monitor.example.com';
const TRUSTED = 'http://localhost:5173';
const HEAD = Buffer.alloc(0);

function setup(withAgent = true) {
  const cli = { handleUpgrade: jest.fn() };
  const tail = { handleUpgrade: jest.fn() };
  const agent = { handleUpgrade: jest.fn() };
  const route = createUpgradeRouter({
    cli,
    tail,
    agent: withAgent ? agent : null,
    trustedOrigins: [TRUSTED],
  });
  return { cli, tail, agent, route };
}

function makeRequest(url: string, origin?: string): IncomingMessage {
  return { url, headers: { host: HOST, origin } } as unknown as IncomingMessage;
}

describe.each([
  ['/cli/ws', 'cli'],
  ['/api/cli/ws', 'cli'],
  ['/monitor/ws?sessionId=s1', 'tail'],
  ['/api/monitor/ws?sessionId=s1', 'tail'],
] as const)('upgrade router on %s', (url, name) => {
  it.each([
    ['a same-host http', `http://${HOST}`],
    ['a same-host https', `https://${HOST}`],
    ['a trusted', TRUSTED],
    ['no', undefined],
  ])('dispatches an upgrade with %s origin', (_label, origin) => {
    const routes = setup();
    const socket = new FakeSocket();
    const request = makeRequest(url, origin);
    routes.route(request, socket as unknown as Socket, HEAD);
    expect(routes[name].handleUpgrade).toHaveBeenCalledWith(request, socket, HEAD);
    expect(socket.destroyed).toBe(false);
    expect(socket.written).toEqual([]);
  });

  it('rejects a foreign origin with HTTP 403 before the gateway runs', () => {
    const routes = setup();
    const socket = new FakeSocket();
    routes.route(makeRequest(url, 'https://evil.example'), socket as unknown as Socket, HEAD);
    expect(socket.written[0].startsWith('HTTP/1.1 403 Forbidden')).toBe(true);
    expect(socket.destroyed).toBe(true);
    expect(routes.cli.handleUpgrade).not.toHaveBeenCalled();
    expect(routes.tail.handleUpgrade).not.toHaveBeenCalled();
  });

  it('survives a socket error after rejecting', () => {
    const routes = setup();
    const socket = new FakeSocket();
    routes.route(makeRequest(url, 'https://evil.example'), socket as unknown as Socket, HEAD);
    expect(() => {
      socket.emit('error', new Error('reset'));
    }).not.toThrow();
  });
});

describe('upgrade router on other paths', () => {
  it('dispatches agent upgrades without an origin check', () => {
    const routes = setup();
    const socket = new FakeSocket();
    const request = makeRequest('/agent/ws', 'https://evil.example');
    routes.route(request, socket as unknown as Socket, HEAD);
    expect(routes.agent.handleUpgrade).toHaveBeenCalledWith(request, socket, HEAD);
  });

  it('destroys agent upgrades when no agent gateway is registered', () => {
    const routes = setup(false);
    const socket = new FakeSocket();
    routes.route(makeRequest('/api/agent/ws'), socket as unknown as Socket, HEAD);
    expect(routes.agent.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
  });

  it('destroys upgrades for unknown paths', () => {
    const routes = setup();
    const socket = new FakeSocket();
    routes.route(makeRequest('/elsewhere', `https://${HOST}`), socket as unknown as Socket, HEAD);
    expect(socket.destroyed).toBe(true);
    expect(routes.cli.handleUpgrade).not.toHaveBeenCalled();
    expect(routes.tail.handleUpgrade).not.toHaveBeenCalled();
  });
});
