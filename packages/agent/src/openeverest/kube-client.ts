import { readFileSync } from 'fs';
import * as https from 'https';
import * as http from 'http';

// A small Kubernetes API client for the plugin's own ServiceAccount: typed
// GET/PUT/POST/PATCH plus a list-then-watch informer. The official client is
// several megabytes and the agent image stays lean; the handful of calls the
// OpenEverest mode makes (Instances, Secrets, one ConfigMap) fit here.

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  [key: string]: unknown;
}

export interface KubeList<T extends KubeObject = KubeObject> {
  metadata: { resourceVersion?: string; continue?: string };
  items: T[];
}

export interface WatchEvent<T extends KubeObject = KubeObject> {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object: T;
}

export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Kubernetes API ${status} on ${path}: ${body.slice(0, 200)}`);
  }
}

export interface KubeClientOptions {
  server: string;
  /** Bearer token, or a reader for one (projected tokens rotate, so re-read per request). */
  token: string | (() => string);
  ca?: string | Buffer;
  /** Namespace the client runs in. */
  namespace: string;
}

export class KubeClient {
  private readonly agent: https.Agent | http.Agent;
  private readonly base: URL;

  constructor(private readonly options: KubeClientOptions) {
    this.base = new URL(options.server);
    this.agent = this.base.protocol === 'https:'
      ? new https.Agent({ ca: options.ca, keepAlive: true })
      : new http.Agent({ keepAlive: true });
  }

  /** The pod's ServiceAccount, mounted by Kubernetes at the usual path. */
  static inCluster(): KubeClient {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    if (!host) {
      throw new Error('KUBERNETES_SERVICE_HOST is not set: the OpenEverest mode must run inside a pod');
    }
    const server = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
    return new KubeClient({
      server,
      token: () => readFileSync(`${SA_DIR}/token`, 'utf8').trim(),
      ca: readFileSync(`${SA_DIR}/ca.crt`),
      namespace: process.env.POD_NAMESPACE || readFileSync(`${SA_DIR}/namespace`, 'utf8').trim(),
    });
  }

  get namespace(): string {
    return this.options.namespace;
  }

  private token(): string {
    return typeof this.options.token === 'function' ? this.options.token() : this.options.token;
  }

  private request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<http.IncomingMessage> {
    const url = new URL(path, this.base);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          agent: this.agent,
          signal,
          headers: {
            Authorization: `Bearer ${this.token()}`,
            Accept: 'application/json',
            ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        },
        resolve,
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  private async json<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const res = await this.request(method, path, body, headers);
    const text = await readBody(res);
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) throw new KubeApiError(status, path, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.json<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('PUT', path, body);
  }

  /** JSON merge patch (RFC 7386). */
  mergePatch<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>('PATCH', path, body, { 'Content-Type': 'application/merge-patch+json' });
  }

  /**
   * Streams watch events for `path` (which must already carry its query
   * string) until the server closes the stream or `signal` aborts. The caller
   * handles reconnects; see Informer.
   */
  async watch<T extends KubeObject>(
    path: string,
    resourceVersion: string | undefined,
    onEvent: (event: WatchEvent<T>) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const sep = path.includes('?') ? '&' : '?';
    const rv = resourceVersion ? `&resourceVersion=${encodeURIComponent(resourceVersion)}` : '';
    const url = `${path}${sep}watch=true&allowWatchBookmarks=true${rv}`;
    const res = await this.request('GET', url, undefined, {}, signal);
    const status = res.statusCode ?? 0;
    if (status !== 200) {
      throw new KubeApiError(status, url, await readBody(res));
    }
    let buffer = '';
    await new Promise<void>((resolve, reject) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              onEvent(JSON.parse(line) as WatchEvent<T>);
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
              res.destroy();
              return;
            }
          }
          newline = buffer.indexOf('\n');
        }
      });
      res.on('end', resolve);
      res.on('error', (err) => (signal.aborted ? resolve() : reject(err)));
    });
  }
}

function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

export interface InformerOptions<T extends KubeObject> {
  client: KubeClient;
  /** Collection path, e.g. /api/v1/namespaces/db/secrets. */
  path: string;
  /** Extra query, e.g. fieldSelector=metadata.name=foo. */
  query?: string;
  /** Called with the object, or null once it is gone. */
  onChange: (key: string, object: T | null) => void;
  /** Called after the first list and every relist, with every key currently known. */
  onSynced?: () => void;
  log?: (message: string) => void;
  /** Backoff ceiling between reconnects. */
  maxBackoffMs?: number;
}

const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * List-then-watch with a local cache, the shape client-go calls an informer.
 * On any stream error (including 410 Gone after a long disconnect) it lists
 * again and diffs against the cache, so a consumer only ever sees onChange
 * with the latest object or null. Keys are namespace/name.
 */
export class Informer<T extends KubeObject> {
  private readonly cache = new Map<string, T>();
  private readonly controller = new AbortController();
  private running: Promise<void> | null = null;
  private attempt = 0;

  constructor(private readonly options: InformerOptions<T>) {}

  static key(object: KubeObject): string {
    return object.metadata.namespace ? `${object.metadata.namespace}/${object.metadata.name}` : object.metadata.name;
  }

  get(key: string): T | undefined {
    return this.cache.get(key);
  }

  items(): T[] {
    return Array.from(this.cache.values());
  }

  start(): void {
    if (this.running) return;
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running?.catch(() => undefined);
    this.running = null;
  }

  private listPath(): string {
    return this.options.query ? `${this.options.path}?${this.options.query}` : this.options.path;
  }

  private async loop(): Promise<void> {
    const signal = this.controller.signal;
    while (!signal.aborted) {
      try {
        const list = await this.options.client.get<KubeList<T>>(this.listPath());
        this.reconcile(list.items);
        this.attempt = 0;
        this.options.onSynced?.();
        await this.options.client.watch<T>(this.listPath(), list.metadata.resourceVersion, (event) => {
          if (event.type === 'ERROR') {
            // Typically 410 Gone: the resourceVersion is too old. Relist.
            throw new Error(`watch error: ${JSON.stringify(event.object).slice(0, 200)}`);
          }
          if (event.type === 'BOOKMARK') return;
          this.apply(event.type === 'DELETED' ? null : event.object, Informer.key(event.object));
        }, signal);
      } catch (err) {
        if (signal.aborted) return;
        this.attempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(this.attempt, 6), this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
        this.options.log?.(`watch on ${this.options.path} failed (${(err as Error).message}); retrying in ${delay}ms`);
        await sleep(delay, signal);
      }
    }
  }

  private reconcile(items: T[]): void {
    const seen = new Set<string>();
    for (const item of items) {
      const key = Informer.key(item);
      seen.add(key);
      this.apply(item, key);
    }
    for (const key of Array.from(this.cache.keys())) {
      if (!seen.has(key)) this.apply(null, key);
    }
  }

  private apply(object: T | null, key: string): void {
    const previous = this.cache.get(key);
    if (object === null) {
      if (previous === undefined) return;
      this.cache.delete(key);
      this.options.onChange(key, null);
      return;
    }
    if (previous && previous.metadata.resourceVersion === object.metadata.resourceVersion) return;
    this.cache.set(key, object);
    this.options.onChange(key, object);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
