import * as http from 'http';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { EverestApiError } from './everest-client';
import type { InstanceRef } from './everest-client';
import type { TargetStatus } from './instance-target';

// HTTP surface of the plugin. OpenEverest reverse-proxies
// /v1/clusters/{cluster}/plugins/{name}/* to the backend Service with the
// prefix stripped, so routes here are bare: /main.js for the UI bundle,
// /healthz and /readyz for the probes and /api/... for the tab and the
// (read-only) settings panel.
// The proxy checks the user's JWT (and the `use` permission on the plugin)
// for POST/PUT/DELETE, but not for GET, so nothing sensitive is served on GET,
// and nothing here changes where the agents stream to.

export interface SettingsView {
  /** BetterDB WebSocket URL the agents dial. */
  url: string;
  tokenSet: boolean;
  /** Web URL of the BetterDB that `url` belongs to, for the deep link. */
  dashboardUrl: string | null;
  /** Where the settings came from: the Secret, env fallback, or nowhere yet. */
  source: 'secret' | 'env' | 'none';
}

export interface InstanceView {
  ref: InstanceRef;
  enabled: boolean;
  status: TargetStatus;
  dashboardUrl: string | null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the server needs from the target manager. */
export interface PluginBackend {
  enable(ref: InstanceRef, authorization: string): Promise<InstanceView>;
  disable(ref: InstanceRef, authorization: string): Promise<InstanceView>;
  status(ref: InstanceRef): InstanceView;
  settings(): SettingsView;
}

export interface PluginServerOptions {
  backend: PluginBackend;
  uiDir: string;
  log: (message: string) => void;
  /** Readiness: true once the target manager has started. /healthz is liveness and never waits on it. */
  ready: () => boolean;
}

const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

// Errors the routes let through, mapped to a status: the OpenEverest client's
// own (502 when the API is unreachable), a malformed percent-encoding in the
// path (400), anything else 500.
function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof EverestApiError) return err.status;
  if (err instanceof URIError) return 400;
  return 500;
}

export function parseInstanceRef(cluster: string, namespace: string, instance: string): InstanceRef {
  const ref = { cluster: decodeURIComponent(cluster), namespace: decodeURIComponent(namespace), instance: decodeURIComponent(instance) };
  if (!DNS_SUBDOMAIN.test(ref.cluster) || !DNS_LABEL.test(ref.namespace) || !DNS_SUBDOMAIN.test(ref.instance)) {
    throw new HttpError(400, 'invalid instance reference');
  }
  return ref;
}

export function createPluginServer(options: PluginServerOptions): http.Server {
  const bundles = new Map<string, Promise<{ body: Buffer; etag: string } | null>>();
  const bundle = (file: string) => {
    let cached = bundles.get(file);
    if (!cached) {
      cached = readFile(join(options.uiDir, file))
        .then((body) => ({ body, etag: `"${createHash('sha256').update(body).digest('hex')}"` }))
        .catch(() => null);
      bundles.set(file, cached);
    }
    return cached;
  };

  return http.createServer(async (req, res) => {
    try {
      await route(req, res, options, bundle);
    } catch (err) {
      const status = statusFor(err);
      if (status >= 500) options.log(`${req.method} ${req.url}: ${(err as Error).message}`);
      sendJson(res, status, { error: (err as Error).message || 'internal error' });
    }
  });
}

async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: PluginServerOptions,
  bundle: (file: string) => Promise<{ body: Buffer; etag: string } | null>,
): Promise<void> {
  const { backend } = options;
  const url = new URL(req.url || '/', 'http://plugin');
  const method = req.method || 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/readyz') {
    const ready = options.ready();
    sendJson(res, ready ? 200 : 503, { ready });
    return;
  }

  if (method === 'GET' && (path === '/main.js' || path === '/icon.svg')) {
    const file = await bundle(path.slice(1));
    if (!file) throw new HttpError(404, `${path} is not built into this image`);
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': path.endsWith('.js') ? 'application/javascript' : 'image/svg+xml',
      'Content-Length': file.body.length,
      'Cache-Control': 'no-cache',
      ETag: file.etag,
    });
    res.end(file.body);
    return;
  }

  const instanceMatch = /^\/api\/instances\/([^/]+)\/([^/]+)\/([^/]+)\/(status|enable|disable)$/.exec(path);
  if (instanceMatch) {
    const ref = parseInstanceRef(instanceMatch[1], instanceMatch[2], instanceMatch[3]);
    const action = instanceMatch[4];
    if (action === 'status' && method === 'GET') {
      sendJson(res, 200, backend.status(ref));
      return;
    }
    if ((action === 'enable' || action === 'disable') && method === 'POST') {
      // Forwarded by the proxy as the browser sent it; used for the
      // authorization check against OpenEverest and then dropped.
      const authorization = req.headers.authorization;
      if (!authorization) throw new HttpError(401, 'missing auth token');
      const view = action === 'enable' ? await backend.enable(ref, authorization) : await backend.disable(ref, authorization);
      sendJson(res, 200, view);
      return;
    }
    throw new HttpError(405, 'method not allowed');
  }

  if (path === '/api/settings') {
    if (method === 'GET') {
      sendJson(res, 200, backend.settings());
      return;
    }
    // Settings are read-only here by design: the URL and token come from the
    // Helm release (values or existingSecret). A backend any pod can reach
    // must not be able to repoint every agent.
    throw new HttpError(405, 'method not allowed');
  }

  throw new HttpError(404, 'not found');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
