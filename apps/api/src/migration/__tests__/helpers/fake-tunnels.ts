import type { SshTunnelParams } from '../../../database/ssh/ssh-tunnel.service';
import { MigrationEndpointResolver } from '../../migration-endpoints';

export const SSH_TUNNEL = {
  enabled: true,
  host: 'bastion.example.com',
  port: 2222,
  username: 'ops',
  authMethod: 'privateKey' as const,
  keySource: 'inline' as const,
  privateKey: 'PEM',
  passphrase: 'secret',
  hostKeyFingerprint: 'SHA256:abc',
};

export class FakeTunnels {
  readonly opened = new Map<string, SshTunnelParams>();
  readonly closed: string[] = [];
  failFor: string | undefined;
  private nextPort = 40001;

  async createTunnel(key: string, params: SshTunnelParams): Promise<number> {
    if (this.failFor !== undefined && key.endsWith(this.failFor)) {
      throw new Error('All configured authentication methods failed');
    }
    this.opened.set(key, params);
    return this.nextPort++;
  }

  async closeTunnel(key: string): Promise<void> {
    this.closed.push(key);
  }

  drop(side: 'source' | 'target'): void {
    for (const [key, params] of this.opened) {
      if (key.endsWith(`:${side}`)) params.onUnexpectedClose?.();
    }
  }
}

export function fakeEndpointResolver(tunnels = new FakeTunnels()): MigrationEndpointResolver {
  return new MigrationEndpointResolver(tunnels);
}
