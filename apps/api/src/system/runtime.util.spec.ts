import {
  isContainerized,
  resolveDefaultDbHost,
  resolveDefaultDbHostChecked,
  resolveDefaultDbPort,
} from './runtime.util';

describe('resolveDefaultDbHost', () => {
  it('prefers an explicit DB_HOST over everything', () => {
    expect(resolveDefaultDbHost({ dbHost: 'valkey.internal', containerized: true })).toEqual({
      host: 'valkey.internal',
      source: 'env',
    });
    expect(resolveDefaultDbHost({ dbHost: 'valkey.internal', containerized: false })).toEqual({
      host: 'valkey.internal',
      source: 'env',
    });
  });

  it('ignores a loopback DB_HOST so the baked image default cannot defeat detection', () => {
    // Dockerfile.prod bakes `ENV DB_HOST=localhost`, which carries no host
    // intent; inside a container it must still resolve to host.docker.internal.
    expect(resolveDefaultDbHost({ dbHost: 'localhost', containerized: true })).toEqual({
      host: 'host.docker.internal',
      source: 'docker',
    });
    for (const loopback of ['localhost', '127.0.0.1', '127.0.0.5', '::1', '0.0.0.0']) {
      expect(resolveDefaultDbHost({ dbHost: loopback, containerized: false })).toEqual({
        host: '127.0.0.1',
        source: 'local',
      });
    }
  });

  it('trims a padded DB_HOST and ignores a blank one', () => {
    expect(resolveDefaultDbHost({ dbHost: '  db.example.com  ', containerized: false })).toEqual({
      host: 'db.example.com',
      source: 'env',
    });
    // Whitespace-only is treated as unset, falling through to detection.
    expect(resolveDefaultDbHost({ dbHost: '   ', containerized: false })).toEqual({
      host: '127.0.0.1',
      source: 'local',
    });
  });

  it('defaults to host.docker.internal inside a container', () => {
    expect(resolveDefaultDbHost({ dbHost: undefined, containerized: true })).toEqual({
      host: 'host.docker.internal',
      source: 'docker',
    });
    expect(resolveDefaultDbHost({ dbHost: null, containerized: true })).toEqual({
      host: 'host.docker.internal',
      source: 'docker',
    });
  });

  it('defaults to 127.0.0.1 on bare metal', () => {
    expect(resolveDefaultDbHost({ dbHost: undefined, containerized: false })).toEqual({
      host: '127.0.0.1',
      source: 'local',
    });
  });
});

describe('resolveDefaultDbPort', () => {
  it('honors a valid DB_PORT', () => {
    expect(resolveDefaultDbPort('6380')).toBe(6380);
    expect(resolveDefaultDbPort('  6380  ')).toBe(6380);
    expect(resolveDefaultDbPort('1')).toBe(1);
    expect(resolveDefaultDbPort('65535')).toBe(65535);
  });

  it('falls back to 6379 for unset or out-of-range values', () => {
    for (const bad of [undefined, null, '', '   ', 'abc', '0', '-1', '70000', '6379.5']) {
      expect(resolveDefaultDbPort(bad)).toBe(6379);
    }
  });
});

describe('resolveDefaultDbHostChecked', () => {
  const resolves = () => Promise.resolve(true);
  const doesNotResolve = () => Promise.resolve(false);

  it('offers host.docker.internal when it resolves', async () => {
    await expect(
      resolveDefaultDbHostChecked({ dbHost: undefined, containerized: true }, resolves),
    ).resolves.toEqual({ host: 'host.docker.internal', source: 'docker' });
  });

  it('falls back to loopback when host.docker.internal does not resolve (--network host)', async () => {
    await expect(
      resolveDefaultDbHostChecked({ dbHost: undefined, containerized: true }, doesNotResolve),
    ).resolves.toEqual({ host: '127.0.0.1', source: 'local' });
  });

  it('never probes for a non-docker result', async () => {
    const probe = jest.fn(resolves);
    await expect(
      resolveDefaultDbHostChecked({ dbHost: 'valkey.internal', containerized: true }, probe),
    ).resolves.toEqual({ host: 'valkey.internal', source: 'env' });
    await expect(
      resolveDefaultDbHostChecked({ dbHost: undefined, containerized: false }, probe),
    ).resolves.toEqual({ host: '127.0.0.1', source: 'local' });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('isContainerized', () => {
  const noEnv: NodeJS.ProcessEnv = {};

  it('detects the Docker /.dockerenv marker', () => {
    expect(
      isContainerized({
        fileExists: (p) => p === '/.dockerenv',
        readCgroup: () => '',
        env: noEnv,
      }),
    ).toBe(true);
  });

  it('detects the Podman /run/.containerenv marker', () => {
    expect(
      isContainerized({
        fileExists: (p) => p === '/run/.containerenv',
        readCgroup: () => '',
        env: noEnv,
      }),
    ).toBe(true);
  });

  it('detects Kubernetes via the injected service-host env', () => {
    expect(
      isContainerized({
        fileExists: () => false,
        readCgroup: () => '',
        env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
      }),
    ).toBe(true);
  });

  it('detects a container runtime from PID 1 cgroup', () => {
    expect(
      isContainerized({
        fileExists: () => false,
        readCgroup: () => '0::/kubepods/burstable/pod123/abcdef',
        env: noEnv,
      }),
    ).toBe(true);
  });

  it('reports false on a bare-metal host', () => {
    expect(
      isContainerized({
        fileExists: () => false,
        readCgroup: () => '0::/user.slice/user-1000.slice/session-2.scope',
        env: noEnv,
      }),
    ).toBe(false);
  });
});
