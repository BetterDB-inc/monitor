/**
 * iovalkey rejects a failed `connect()` with a generic "Connection is closed."
 * and reports the real cause (DNS failure, refused port, ...) only through the
 * client's `error` event. This turns that socket error into a message a user
 * can act on, so the UI and telemetry show "host not found" instead of a
 * closed-connection error that says nothing about what went wrong.
 *
 * Returns null for errors we have no better wording for, so callers keep the
 * original error.
 */
export function describeConnectError(
  socketError: { code?: string; message?: string } | null | undefined,
  host: string,
  port: number,
): string | null {
  switch (socketError?.code) {
    case 'ENOTFOUND':
    case 'ENODATA':
      return `Host "${host}" could not be found. Check the hostname for typos.`;
    case 'EAI_AGAIN':
      return `DNS lookup for "${host}" failed. Check the hostname, or try again if DNS is temporarily unavailable.`;
    case 'ECONNREFUSED':
      return `Connection refused by ${host}:${port}. Check that the server is running and the port is correct.`;
    case 'ETIMEDOUT':
      return `Timed out connecting to ${host}:${port}. Check that the host is reachable and no firewall is blocking the port.`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${host}:${port} is unreachable from this server. Check the address and network access.`;
    default:
      return null;
  }
}
