import { Inject, Injectable } from '@nestjs/common';
import type { DatabaseConnectionConfig } from '@betterdb/shared';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { SshTunnelService } from '../database/ssh/ssh-tunnel.service';

export interface DialEndpoint {
  host: string;
  port: number;
}

export type MigrationSide = 'source' | 'target';

export type MigrationConnectionConfig = DatabaseConnectionConfig & { dial?: DialEndpoint };

export interface MigrationEndpoints {
  source: MigrationConnectionConfig;
  target: MigrationConnectionConfig;
  close(): Promise<void>;
}

type TunnelOpener = Pick<SshTunnelService, 'createTunnel' | 'closeTunnel'>;

type HostKeyStore = Pick<ConnectionRegistry, 'pinLearnedSshHostKey'>;

const LOOPBACK = '127.0.0.1';

export function dialEndpoint(config: Pick<MigrationConnectionConfig, 'host' | 'port' | 'dial'>): DialEndpoint {
  return config.dial ?? { host: config.host, port: config.port };
}

export function usesSshTunnel(config: Pick<DatabaseConnectionConfig, 'sshTunnel'> | null | undefined): boolean {
  return config?.sshTunnel?.enabled === true;
}

export function tunnelClosedMessage(side: MigrationSide): string {
  return `The SSH tunnel to the ${side} closed unexpectedly`;
}

@Injectable()
export class MigrationEndpointResolver {
  constructor(
    @Inject(SshTunnelService) private readonly tunnels: TunnelOpener,
    @Inject(ConnectionRegistry) private readonly hostKeys: HostKeyStore,
  ) {}

  async open(
    jobId: string,
    configs: Record<MigrationSide, DatabaseConnectionConfig>,
    onTunnelClosed: (side: MigrationSide) => void,
  ): Promise<MigrationEndpoints> {
    const keys: string[] = [];
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await Promise.all(keys.map((key) => this.tunnels.closeTunnel(key)));
    };

    const resolve = async (side: MigrationSide): Promise<MigrationConnectionConfig> => {
      const config = configs[side];
      const tunnel = config.sshTunnel;
      if (!tunnel || !usesSshTunnel(config)) return config;
      const key = `migration:${jobId}:${side}`;
      let learnedHostKey: string | undefined;
      try {
        const port = await this.tunnels.createTunnel(key, {
          sshHost: tunnel.host,
          sshPort: tunnel.port,
          sshUsername: tunnel.username,
          authMethod: tunnel.authMethod,
          password: tunnel.password,
          keySource: tunnel.keySource,
          privateKey: tunnel.privateKey,
          privateKeyPath: tunnel.privateKeyPath,
          passphrase: tunnel.passphrase,
          hostKeyFingerprint: tunnel.hostKeyFingerprint,
          onHostKey: (fingerprint) => {
            learnedHostKey = fingerprint;
          },
          remoteHost: config.host,
          remotePort: config.port,
          onUnexpectedClose: () => onTunnelClosed(side),
        });
        keys.push(key);
        if (learnedHostKey !== undefined) {
          await this.hostKeys.pinLearnedSshHostKey(config.id, learnedHostKey);
        }
        return { ...config, dial: { host: LOOPBACK, port } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not open the SSH tunnel to the ${side}: ${message}`, { cause: error });
      }
    };

    try {
      const source = await resolve('source');
      const target = await resolve('target');
      return { source, target, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
