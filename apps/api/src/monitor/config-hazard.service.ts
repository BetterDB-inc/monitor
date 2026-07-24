import { Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { ConfigHazardFinding, evaluateAclAofHazard } from './config-hazard';

interface CachedFindings {
  findings: ConfigHazardFinding[];
  expiresAt: number;
}

interface ProbeClientLike {
  getConfigValue(parameter: string): Promise<string | null>;
  call(command: string, args: string[]): Promise<unknown>;
  getCapabilities(): { version: string | null };
}

/**
 * Probes each connection for hazardous static configuration (valkey#3983) on
 * the health-polling path. Results are TTL-cached per connection so dashboard
 * polling does not hammer CONFIG GET / ACL GETUSER.
 */
@Injectable()
export class ConfigHazardService {
  private readonly logger = new Logger(ConfigHazardService.name);
  private readonly cache = new Map<string, CachedFindings>();
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(private readonly connectionRegistry: ConnectionRegistry) {}

  async getHazards(connectionId: string): Promise<ConfigHazardFinding[]> {
    const cached = this.cache.get(connectionId);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.findings;
    }

    const findings = await this.probe(connectionId);
    this.cache.set(connectionId, {
      findings,
      expiresAt: Date.now() + ConfigHazardService.CACHE_TTL_MS,
    });
    return findings;
  }

  private async probe(connectionId: string): Promise<ConfigHazardFinding[]> {
    let client: ProbeClientLike;
    try {
      client = this.connectionRegistry.get(connectionId) as unknown as ProbeClientLike;
    } catch (err) {
      this.logger.debug(
        `Config-hazard probe skipped for ${connectionId}: ${(err as Error).message}`,
      );
      return [];
    }

    let appendonly: string | null;
    try {
      appendonly = await client.getConfigValue('appendonly');
    } catch (err) {
      this.logger.debug(
        `CONFIG GET appendonly failed for ${connectionId}: ${(err as Error).message}`,
      );
      return [];
    }

    if (appendonly !== 'yes') {
      return [];
    }

    let version: string | null;
    try {
      version = client.getCapabilities().version;
    } catch {
      version = null;
    }

    let aclGetUserResult: unknown;
    try {
      aclGetUserResult = await client.call('ACL', ['GETUSER', 'default']);
    } catch (err) {
      this.logger.debug(
        `ACL GETUSER default failed for ${connectionId}: ${(err as Error).message}`,
      );
      aclGetUserResult = 'denied';
    }

    const finding = evaluateAclAofHazard({ appendonly, version, aclGetUserResult });
    if (finding === null) {
      return [];
    }
    return [finding];
  }
}
