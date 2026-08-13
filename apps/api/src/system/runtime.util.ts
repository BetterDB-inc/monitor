import { existsSync, readFileSync } from 'fs';
import { lookup } from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(lookup);

export type DefaultDbHostSource = 'env' | 'docker' | 'local';

export interface DefaultDbHost {
  host: string;
  source: DefaultDbHostSource;
}

/** Valkey/Redis default port, used whenever DB_PORT is unset or unparseable. */
const DEFAULT_DB_PORT = 6379;

/** How long to wait for the host.docker.internal DNS probe before giving up. */
const HOST_RESOLVE_TIMEOUT_MS = 500;

/** Loopback / "this machine" hosts that carry no cross-host intent. */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/**
 * Resolve the host to pre-fill for a one-click LOCAL connection. Kept pure so
 * the precedence is unit-testable; the impurity (are we in a container?) is
 * injected.
 *
 * Precedence:
 *   1. A NON-LOOPBACK DB_HOST the operator set wins outright — they told us
 *      where the database is. A loopback DB_HOST is deliberately NOT treated as
 *      an override: the published image bakes in `ENV DB_HOST=localhost`
 *      (Dockerfile.prod), which carries no host intent, and honoring it would
 *      short-circuit detection and resolve to the container itself — the very
 *      failure this endpoint exists to prevent.
 *   2. When the monitor runs INSIDE a container, `localhost` is the container
 *      itself, not the operator's machine — the host's services live at
 *      `host.docker.internal`. That name resolves on the default bridge AND on
 *      compose/custom bridge networks when the container is run with
 *      `--add-host=host.docker.internal:host-gateway` (and natively on Docker
 *      Desktop), which is why we prefer it over the default-bridge gateway IP.
 *   3. Bare-metal: `127.0.0.1` is correct.
 */
export function resolveDefaultDbHost(input: {
  dbHost?: string | null;
  containerized: boolean;
}): DefaultDbHost {
  const explicit = input.dbHost?.trim();
  if (explicit && !isLoopbackHost(explicit)) {
    return { host: explicit, source: 'env' };
  }
  if (input.containerized) {
    return { host: 'host.docker.internal', source: 'docker' };
  }
  return { host: '127.0.0.1', source: 'local' };
}

/** DB_PORT the operator set, validated. Falls back to the Valkey default. */
export function resolveDefaultDbPort(dbPort?: string | null): number {
  const n = Number(dbPort?.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_DB_PORT;
}

/** Can this hostname be resolved from the API process? Never throws. */
export type HostResolver = (host: string) => Promise<boolean>;

const defaultCanResolveHost: HostResolver = async (host) => {
  try {
    await Promise.race([
      dnsLookup(host),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('dns-timeout')), HOST_RESOLVE_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Like resolveDefaultDbHost, but verifies host.docker.internal actually
 * resolves before recommending it. Under `--network host` the container shares
 * the host's network namespace, so `127.0.0.1` already reaches the host's
 * services, but Docker does NOT inject `host.docker.internal` — offering it
 * would hand the UI a name that fails with ENOTFOUND. When the probe can't
 * resolve it, fall back to loopback (the correct target under host networking).
 * The probe is injectable so the precedence stays unit-testable.
 */
export async function resolveDefaultDbHostChecked(
  input: { dbHost?: string | null; containerized: boolean },
  canResolveHost: HostResolver = defaultCanResolveHost,
): Promise<DefaultDbHost> {
  const resolved = resolveDefaultDbHost(input);
  if (resolved.source === 'docker' && !(await canResolveHost(resolved.host))) {
    return { host: '127.0.0.1', source: 'local' };
  }
  return resolved;
}

interface ContainerProbeDeps {
  fileExists: (path: string) => boolean;
  readCgroup: () => string;
  env: NodeJS.ProcessEnv;
}

const defaultProbeDeps: ContainerProbeDeps = {
  fileExists: existsSync,
  readCgroup: () => {
    try {
      return readFileSync('/proc/1/cgroup', 'utf8');
    } catch {
      return '';
    }
  },
  env: process.env,
};

/**
 * Best-effort detection of whether the API process runs inside a container.
 * Never throws — a false negative just falls back to the 127.0.0.1 default,
 * which is exactly what a bare-metal install wants anyway.
 */
export function isContainerized(deps: Partial<ContainerProbeDeps> = {}): boolean {
  const { fileExists, readCgroup, env } = { ...defaultProbeDeps, ...deps };

  // Docker writes /.dockerenv; Podman writes /run/.containerenv.
  if (fileExists('/.dockerenv') || fileExists('/run/.containerenv')) {
    return true;
  }
  // Kubernetes injects this into every in-cluster pod.
  if (env.KUBERNETES_SERVICE_HOST) {
    return true;
  }
  // Fallback: PID 1's cgroup path names the container runtime.
  return /(?:docker|kubepods|containerd|libpod|lxc)/i.test(readCgroup());
}
