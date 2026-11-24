// The connection Secret an OpenEverest provider publishes for an instance
// (`Instance.status.connectionSecretRef`, named `<instance>-conn` by
// provider-valkey). Keys, all strings: type, provider, host, port, username,
// password, uri; with TLS on also ssl=true and ca.crt; and tls.crt + tls.key
// when the server accepts client certificates.

export interface ConnectionCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: { ca?: string; cert?: string; key?: string } | null;
  /** Engine type as the provider reports it (`valkey`). */
  type?: string;
}

export interface SecretLike {
  data?: Record<string, string>;
  stringData?: Record<string, string>;
}

function decode(secret: SecretLike, key: string): string | undefined {
  const plain = secret.stringData?.[key];
  if (plain !== undefined) return plain;
  const encoded = secret.data?.[key];
  if (encoded === undefined) return undefined;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/**
 * Reads the credentials out of a connection Secret. Throws when the Secret
 * has no host yet (the provider writes it once the instance is ready) or
 * claims TLS without a CA, which the agent could not verify anything with.
 */
export function parseConnectionSecret(secret: SecretLike): ConnectionCredentials {
  const host = decode(secret, 'host')?.trim();
  if (!host) throw new Error('connection secret has no host yet');

  const rawPort = decode(secret, 'port')?.trim();
  const port = rawPort ? parseInt(rawPort, 10) : 6379;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`connection secret has an invalid port: ${rawPort}`);
  }

  const uri = decode(secret, 'uri');
  const ssl = decode(secret, 'ssl')?.trim().toLowerCase();
  const tlsOn = ssl === 'true' || (ssl === undefined && uri?.startsWith('rediss://') === true);

  let tls: ConnectionCredentials['tls'] = null;
  if (tlsOn) {
    const ca = decode(secret, 'ca.crt');
    if (!ca) throw new Error('connection secret enables TLS but carries no ca.crt');
    const cert = decode(secret, 'tls.crt');
    const key = decode(secret, 'tls.key');
    if ((cert && !key) || (!cert && key)) {
      throw new Error('connection secret has only one half of the client certificate');
    }
    tls = cert && key ? { ca, cert, key } : { ca };
  }

  return {
    host,
    port,
    username: decode(secret, 'username') || 'default',
    password: decode(secret, 'password') ?? '',
    tls,
    type: decode(secret, 'type')?.trim() || undefined,
  };
}
