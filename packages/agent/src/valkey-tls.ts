import type { ConnectionOptions as TlsConnectionOptions } from 'tls';

/** TLS material for a Valkey connection, as the OpenEverest connection Secret provides it. */
export interface ValkeyTlsMaterial {
  ca?: string;
  cert?: string;
  key?: string;
  /**
   * False verifies the certificate chain against `ca` but not the server name:
   * cluster nodes are dialled by pod IP, which is never in their certificate.
   */
  verifyHostname?: boolean;
}

/** Node TLS options for `material`; `{}` (system trust, full verification) when none is given. */
export function valkeyTlsOptions(material?: ValkeyTlsMaterial): TlsConnectionOptions {
  if (!material) return {};
  const tls: TlsConnectionOptions = {};
  if (material.ca) tls.ca = material.ca;
  if (material.cert) tls.cert = material.cert;
  if (material.key) tls.key = material.key;
  // Chain-only: a successful chain check returns undefined here, which
  // tls.connect takes as "identity ok".
  if (material.verifyHostname === false) tls.checkServerIdentity = () => undefined;
  return tls;
}
