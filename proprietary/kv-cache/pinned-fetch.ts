import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions, type LookupOptions } from 'dns';
import http from 'http';
import https from 'https';
import { Readable } from 'stream';
import { isBlockedIp } from '@app/common/utils/outbound-url-guard';

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
type Resolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const LOOPBACK_ANSWER = /^(127\.|::1$|::ffff:127\.)/i;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKED';
}

export function guardedLookup(allowPrivateNetworks: boolean, resolve: Resolver = dnsLookup as Resolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '');
      const trustedLocalhost = hostname === 'localhost' && process.env.NODE_ENV !== 'production';
      const blocked = addresses.find(
        (entry) => !(trustedLocalhost && LOOPBACK_ANSWER.test(entry.address)) && isBlockedIp(entry.address, allowPrivateNetworks),
      );
      if (blocked) return callback(new BlockedAddressError(`blocked address ${blocked.address}`), '');
      if (addresses.length === 0) return callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '');
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function responseHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

export function pinnedFetch(allowPrivateNetworks: boolean, resolve?: Resolver): typeof fetch {
  const lookup = guardedLookup(allowPrivateNetworks, resolve);
  return ((input: string | URL, init?: RequestInit) =>
    new Promise<Response>((resolveResponse, rejectResponse) => {
      const url = new URL(String(input));
      const client = url.protocol === 'https:' ? https : http;
      const request = client.request(
        url,
        {
          method: 'GET',
          headers: init?.headers as Record<string, string> | undefined,
          signal: init?.signal ?? undefined,
          lookup: lookup as unknown as http.RequestOptions['lookup'],
        },
        (response) => {
          try {
            const status = response.statusCode ?? 502;
            const body = NULL_BODY_STATUSES.has(status) ? null : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>);
            if (!body) response.resume();
            resolveResponse(new Response(body, { status, headers: responseHeaders(response.headers) }));
          } catch (error) {
            response.destroy();
            rejectResponse(error);
          }
        },
      );
      request.on('error', rejectResponse);
      request.end();
    })) as typeof fetch;
}
