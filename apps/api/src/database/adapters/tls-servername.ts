import { checkServerIdentity, type ConnectionOptions } from 'tls';

export type TlsIdentityOptions = Pick<ConnectionOptions, 'servername' | 'checkServerIdentity'>;

export function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export function tlsServernameFor(host: string, announcedHostname?: string): string | undefined {
  if (!isIpAddress(host)) {
    return host;
  }
  if (announcedHostname && !isIpAddress(announcedHostname)) {
    return announcedHostname;
  }
  return undefined;
}

export function tlsIdentityOptions(host: string, announcedHostname?: string): TlsIdentityOptions {
  const servername = tlsServernameFor(host, announcedHostname);
  if (!servername) {
    return {};
  }
  if (servername === host) {
    return { servername };
  }
  return {
    servername,
    checkServerIdentity: (_name, certificate) => {
      const hostnameMismatch = checkServerIdentity(servername, certificate);
      if (!hostnameMismatch) {
        return undefined;
      }
      return checkServerIdentity(host, certificate) ? hostnameMismatch : undefined;
    },
  };
}
