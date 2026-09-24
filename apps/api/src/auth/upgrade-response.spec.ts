import { Socket } from 'net';
import { rejectUpgrade } from './upgrade-response';

class FakeSocket {
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

describe('rejectUpgrade', () => {
  it('writes a minimal HTTP response and destroys the socket', () => {
    const socket = new FakeSocket();
    rejectUpgrade(socket as unknown as Socket, 401);
    expect(socket.written[0]).toBe(
      'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
    expect(socket.destroyed).toBe(true);
  });

  it('uses the Forbidden reason phrase for 403', () => {
    const socket = new FakeSocket();
    rejectUpgrade(socket as unknown as Socket, 403);
    expect(socket.written[0].startsWith('HTTP/1.1 403 Forbidden\r\n')).toBe(true);
  });
});
