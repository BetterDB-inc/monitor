import { existsSync, readFileSync, readdirSync } from 'fs';
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

/**
 * Outcome of a DNS probe. `timed-out` is distinct from `not-found`: a slow
 * answer means the name IS resolvable (just not yet), while `not-found` means
 * the resolver came back and said no such name exists.
 */
export type HostResolution = 'resolved' | 'not-found' | 'timed-out';

/** Can this hostname be resolved from the API process? Never throws. */
export type HostResolver = (host: string) => Promise<HostResolution>;

const defaultCanResolveHost: HostResolver = async (host) => {
  let timedOut = false;
  try {
    await Promise.race([
      dnsLookup(host),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          timedOut = true;
          reject(new Error('dns-timeout'));
        }, HOST_RESOLVE_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    return 'resolved';
  } catch {
    return timedOut ? 'timed-out' : 'not-found';
  }
};

/**
 * Whether the container shares the host's network namespace (`--network host`).
 * A bridged container has its own netns and sees only `lo`/`eth0`; a
 * host-networked one sees the host's container bridges. This is the signal that
 * distinguishes the two `host.docker.internal`-unresolvable cases, which need
 * OPPOSITE hosts (loopback vs. the bridge gateway). We match the bridge names
 * both runtimes create: Docker's `docker0`/`br-*` and Podman's
 * `podman0`/`cni-podman0` (and other `cni-*` bridges). A bridged container
 * never sees any of these, so a match reliably means host networking.
 */
const defaultIsHostNetwork = (): boolean => {
  try {
    return readdirSync('/sys/class/net').some(
      (n) => n === 'docker0' || n === 'podman0' || n.startsWith('br-') || n.startsWith('cni-'),
    );
  } catch {
    return false;
  }
};

/** IPv4 of PID-visible default route (the host, on a bridge network), or null. */
const defaultGetDefaultGateway = (): string | null => {
  try {
    // /proc/net/route: default route has Destination 00000000; Gateway is a
    // little-endian hex IPv4 (e.g. 010011AC -> 172.17.0.1).
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (
        f.length > 2 &&
        f[1] === '00000000' &&
        /^[0-9A-Fa-f]{8}$/.test(f[2]) &&
        f[2] !== '00000000'
      ) {
        const octets = f[2]
          .match(/../g)!
          .reverse()
          .map((h) => parseInt(h, 16));
        return octets.join('.');
      }
    }
  } catch {
    // fall through
  }
  return null;
};

/**
 * Is the process on an actual Docker/Podman runtime (as opposed to generic
 * containerization like Kubernetes/ECS/Fargate)? Only these leave a filesystem
 * marker AND have a default-route gateway that is the operator's host. On a CNI
 * platform the default route is the pod/task gateway (e.g. 10.244.0.1), which is
 * NOT where a database lives, so the gateway fallback must not fire there.
 */
const defaultHasDockerRuntime = (): boolean =>
  existsSync('/.dockerenv') || existsSync('/run/.containerenv');

export interface HostProbeDeps {
  canResolveHost: HostResolver;
  isHostNetwork: () => boolean;
  getDefaultGateway: () => string | null;
  hasDockerRuntime: () => boolean;
}

/**
 * Like resolveDefaultDbHost, but resolves the containerized `host.docker.internal`
 * default to something that actually reaches the host, since that name only
 * resolves on Docker Desktop or with `--add-host=host.docker.internal:host-gateway`.
 * A `timed-out` probe is NOT treated as unresolvable: on Docker Desktop the name
 * is genuinely resolvable but a cold/contended embedded resolver can be slower
 * than the probe budget, and misreading that as "missing" would fall through to
 * the bridge-gateway IP — the Docker Desktop Linux VM, not the real host. The
 * optimistic answer (host.docker.internal) is the safer default on timeout; the
 * probe only runs once since the result is cached by the caller.
 * When the resolver comes back with a definitive `not-found`, we disambiguate:
 *   - `--network host` (shared netns): the host is at `127.0.0.1`.
 *   - default/custom bridge (the README's primary `docker run`): the host is
 *     the default gateway (e.g. 172.17.0.1); `127.0.0.1` would be the container.
 *     This only holds on a real Docker/Podman bridge, so it is gated on the
 *     runtime marker — on Kubernetes/ECS/Fargate the default route is the CNI
 *     gateway, not the host, and we fall back to loopback instead.
 * Loopback is the last resort when neither signal is available. All probes are
 * injectable so the precedence stays unit-testable.
 */
export async function resolveDefaultDbHostChecked(
  input: { dbHost?: string | null; containerized: boolean },
  deps: Partial<HostProbeDeps> = {},
): Promise<DefaultDbHost> {
  const canResolveHost = deps.canResolveHost ?? defaultCanResolveHost;
  const isHostNetwork = deps.isHostNetwork ?? defaultIsHostNetwork;
  const getDefaultGateway = deps.getDefaultGateway ?? defaultGetDefaultGateway;
  const hasDockerRuntime = deps.hasDockerRuntime ?? defaultHasDockerRuntime;

  const resolved = resolveDefaultDbHost(input);
  if (resolved.source !== 'docker') {
    return resolved;
  }
  const resolution = await canResolveHost(resolved.host);
  if (resolution === 'resolved' || resolution === 'timed-out') {
    return resolved;
  }
  // host.docker.internal is definitively unreachable — pick the right host for the netmode.
  if (isHostNetwork()) {
    return { host: '127.0.0.1', source: 'local' };
  }
  // The default-route gateway is the host only on a real Docker/Podman bridge;
  // on a CNI platform it is the pod/task gateway, so require the runtime marker.
  const gateway = hasDockerRuntime() ? getDefaultGateway() : null;
  if (gateway) {
    return { host: gateway, source: 'docker' };
  }
  return { host: '127.0.0.1', source: 'local' };
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
