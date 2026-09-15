import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { isTrustedUpgradeOrigin } from '../../auth/trusted-origins';
import { rejectUpgrade } from '../../auth/upgrade-response';

export interface UpgradeTarget {
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void;
}

export interface UpgradeRoutes {
  cli: UpgradeTarget;
  tail: UpgradeTarget;
  agent: UpgradeTarget | null;
  trustedOrigins: readonly string[];
}

export type UpgradeListener = (request: IncomingMessage, socket: Socket, head: Buffer) => void;

const CLI_PATHS = new Set(['/cli/ws', '/api/cli/ws']);
const TAIL_PATHS = new Set(['/monitor/ws', '/api/monitor/ws']);
const AGENT_PATHS = new Set(['/agent/ws', '/api/agent/ws']);

function pathnameOf(request: IncomingMessage): string | null {
  try {
    return new URL(request.url || '', `http://${request.headers.host}`).pathname;
  } catch {
    return null;
  }
}

function browserTargetFor(routes: UpgradeRoutes, pathname: string): UpgradeTarget | null {
  if (CLI_PATHS.has(pathname)) {
    return routes.cli;
  }
  if (TAIL_PATHS.has(pathname)) {
    return routes.tail;
  }
  return null;
}

export function createUpgradeRouter(routes: UpgradeRoutes): UpgradeListener {
  return (request, socket, head) => {
    const pathname = pathnameOf(request);
    if (pathname === null) {
      socket.destroy();
      return;
    }
    const browserTarget = browserTargetFor(routes, pathname);
    if (browserTarget !== null) {
      if (isTrustedUpgradeOrigin(request, routes.trustedOrigins) === false) {
        socket.on('error', () => {
          socket.destroy();
        });
        rejectUpgrade(socket, 403);
        return;
      }
      browserTarget.handleUpgrade(request, socket, head);
      return;
    }
    if (routes.agent !== null && AGENT_PATHS.has(pathname)) {
      routes.agent.handleUpgrade(request, socket, head);
      return;
    }
    socket.destroy();
  };
}
