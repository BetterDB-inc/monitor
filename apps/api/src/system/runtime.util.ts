import { existsSync, readFileSync } from 'fs';

export type DefaultDbHostSource = 'env' | 'docker' | 'local';

export interface DefaultDbHost {
  host: string;
  source: DefaultDbHostSource;
}

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
