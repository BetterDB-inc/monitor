import { Readable } from 'stream';
import { gunzipSync, inflateSync, type ZlibOptions } from 'zlib';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const OTLP_PATHS = new Set(['/v1/traces', '/v1/external/metrics']);

const DECODERS = new Map<string, (body: Buffer, options: ZlibOptions) => Buffer>([
  ['gzip', gunzipSync],
  ['x-gzip', gunzipSync],
  ['deflate', inflateSync],
]);

type HttpError = Error & { statusCode: number };

function httpError(statusCode: number, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode });
}

export function decompressOtlpBody(encoding: string, body: Buffer, maxOutputLength: number): Buffer {
  const decode = DECODERS.get(encoding);
  if (!decode) throw httpError(415, `Unsupported content encoding: ${encoding}`);
  try {
    return decode(body, { maxOutputLength });
  } catch (err) {
    throw httpError(400, `Failed to decompress ${encoding} body: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

function readAll(payload: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      payload.removeListener('data', onData);
      payload.removeListener('end', onEnd);
      payload.removeListener('error', onError);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        reject(httpError(413, 'Request body is too large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    payload.on('data', onData);
    payload.on('end', onEnd);
    payload.on('error', onError);
  });
}

function contentEncoding(request: FastifyRequest): string {
  const raw = request.headers['content-encoding'];
  return (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).trim().toLowerCase();
}

export function registerOtlpBodyParsing(fastify: FastifyInstance): void {
  const limit = fastify.initialConfig.bodyLimit ?? 1024 * 1024;

  fastify.addContentTypeParser(
    'application/x-protobuf',
    { parseAs: 'buffer' },
    (_req: unknown, body: Buffer, done: (err: Error | null, body?: Buffer) => void) => done(null, body),
  );

  fastify.addHook('preParsing', async (request, _reply, payload) => {
    if (!OTLP_PATHS.has(request.routeOptions.url ?? '')) return payload;
    const encoding = contentEncoding(request);
    if (encoding === '' || encoding === 'identity') return payload;
    if (!DECODERS.has(encoding)) throw httpError(415, `Unsupported content encoding: ${encoding}`);
    const compressed = await readAll(payload, limit);
    const decompressed = decompressOtlpBody(encoding, compressed, limit);
    const stream = Readable.from([decompressed], { objectMode: false });
    return Object.assign(stream, { receivedEncodedLength: compressed.length });
  });
}
