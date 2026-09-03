import type { Socket } from 'net';

const REASONS: Record<401 | 403, string> = { 401: 'Unauthorized', 403: 'Forbidden' };

export function rejectUpgrade(socket: Socket, status: 401 | 403): void {
  socket.write(
    `HTTP/1.1 ${status} ${REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
