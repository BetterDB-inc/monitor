// The one call the plugin makes to the OpenEverest API: reading an instance's
// connection details with the user's own token. The body is thrown away; the
// point is the status code. OpenEverest only answers 200 to users holding the
// `read-connection` permission on that instance, so a 200 means "this user may
// see the admin credentials already" and enabling monitoring is allowed.

export interface InstanceRef {
  cluster: string;
  namespace: string;
  instance: string;
}

export class EverestApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ConnectionCheck =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404; reason: string };

export interface EverestClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Where the OpenEverest API is, following the generic-plugin-template lookup order. */
export function everestApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.EVEREST_API_URL) return env.EVEREST_API_URL.replace(/\/+$/, '');
  if (env.EVEREST_SERVICE_HOST) return `http://${env.EVEREST_SERVICE_HOST}:${env.EVEREST_SERVICE_PORT || '8080'}`;
  // The alpha.1 chart names the API Service `everest` (the Deployment is everest-server).
  return 'http://everest.everest-system.svc.cluster.local:8080';
}

export class EverestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  readonly baseUrl: string;

  constructor(options: EverestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  connectionUrl(ref: InstanceRef): string {
    const { cluster, namespace, instance } = ref;
    return `${this.baseUrl}/v1/clusters/${encodeURIComponent(cluster)}/namespaces/${encodeURIComponent(namespace)}` +
      `/instances/${encodeURIComponent(instance)}/connection`;
  }

  /**
   * Is this a live OpenEverest session? Used before accepting a settings
   * change: the backend is a plain ClusterIP Service, so a request can come
   * from any pod with a made-up header, and the proxy's own JWT check never
   * ran for it. plugin-context sits behind OpenEverest's JWT middleware and
   * answers 2xx only to a valid session.
   */
  async checkSession(cluster: string, authorization: string): Promise<boolean> {
    const res = await this.get(`${this.baseUrl}/v1/clusters/${encodeURIComponent(cluster)}/plugin-context`, authorization);
    if (res.status >= 200 && res.status < 300) return true;
    if (res.status === 401 || res.status === 403) return false;
    throw new EverestApiError(502, `OpenEverest API answered ${res.status} on the session check`);
  }

  private async get(url: string, authorization: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      throw new EverestApiError(502, `OpenEverest API unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    // Drain without keeping the body (credentials, identities) around.
    await res.arrayBuffer().catch(() => undefined);
    return res;
  }

  /**
   * Authorization check for enabling monitoring. `authorization` is the
   * user's `Authorization` header as the plugin proxy forwarded it; it is
   * used for this one request and never stored.
   */
  async checkConnectionAccess(ref: InstanceRef, authorization: string): Promise<ConnectionCheck> {
    const res = await this.get(this.connectionUrl(ref), authorization);

    switch (res.status) {
      case 200:
        return { ok: true };
      case 401:
        return { ok: false, status: 401, reason: 'OpenEverest did not accept the session token' };
      case 403:
        return { ok: false, status: 403, reason: 'enabling BetterDB needs the read-connection permission on this instance' };
      case 404:
        return { ok: false, status: 404, reason: 'the instance has no connection details yet, or does not exist' };
      default:
        throw new EverestApiError(502, `OpenEverest API answered ${res.status} on the connection check`);
    }
  }
}
