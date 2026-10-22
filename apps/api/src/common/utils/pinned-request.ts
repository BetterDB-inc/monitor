import { request as httpRequest, type IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import type { LookupFunction } from 'net';
import { Readable } from 'stream';

export interface PinnedRequestInit {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  lookup?: LookupFunction;
}

export class UnexpectedStatusError extends Error {}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toResponse(message: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const status = message.statusCode ?? 502;
  if (status < 200 || status > 599) throw new UnexpectedStatusError(`unexpected HTTP status ${status}`);
  if (NULL_BODY_STATUSES.has(status)) {
    message.resume();
    return new Response(null, { status, headers });
  }
  return new Response(Readable.toWeb(message) as ReadableStream<Uint8Array>, { status, headers });
}

export const pinnedRequest = (url: string, init: PinnedRequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers = init.body === undefined ? init.headers : { 'Content-Length': String(Buffer.byteLength(init.body)), ...init.headers };
    const req = send(
      target,
      {
        method: init.method ?? 'GET',
        agent: false,
        headers,
        signal: init.signal,
        ...(init.lookup ? { lookup: init.lookup } : {}),
      },
      (message) => {
        try {
          resolve(toResponse(message));
        } catch (error) {
          message.destroy();
          reject(error);
        }
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
