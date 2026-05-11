import { Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { AclCheckResult, AclChecker } from './acl-checker';
import { HealthGateResult } from './health-gate';
import { HealthGateService } from './health-gate.service';
import { ProviderInfo, detectProvider } from './provider-detector';

/** Average bytes per MONITOR-formatted line. Conservative estimate; overestimates short keys, underestimates very long values. */
const AVG_MONITOR_LINE_BYTES = 120;

/** Default capture duration if the caller does not specify one. Matches the user-facing default in the start-session modal. */
const DEFAULT_DURATION_MS = 30_000;

export interface PreflightInput {
  connectionId: string;
  /** Planned capture duration in ms; pre-flight uses this to project capture size. */
  durationMs?: number;
}

export interface PreflightThroughput {
  opsPerSec: number;
  inputKbps: number;
  outputKbps: number;
  durationMs: number;
  estimatedLines: number;
  estimatedBytes: number;
}

export interface PreflightResult {
  connectionId: string;
  provider: ProviderInfo;
  acl: AclCheckResult;
  health: HealthGateResult;
  throughput: PreflightThroughput;
}

@Injectable()
export class PreflightService {
  private readonly logger = new Logger(PreflightService.name);

  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly aclChecker: AclChecker,
    private readonly healthGateService: HealthGateService,
  ) {}

  async run(input: PreflightInput): Promise<PreflightResult> {
    const { connectionId } = input;
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;

    const client = this.connectionRegistry.get(connectionId);
    const config = this.connectionRegistry.getConfig(connectionId);

    const info = await client.getInfoParsed();
    const server = readServerSection(info);
    const stats = readStatsSection(info);

    const opsPerSec = parseOptionalNumber(stats.instantaneous_ops_per_sec) ?? 0;
    const inputKbps = parseOptionalNumber(stats.instantaneous_input_kbps) ?? 0;
    const outputKbps = parseOptionalNumber(stats.instantaneous_output_kbps) ?? 0;
    const estimatedLines = Math.round(opsPerSec * (durationMs / 1000));
    const estimatedBytes = estimatedLines * AVG_MONITOR_LINE_BYTES;

    const [acl, health] = await Promise.all([
      this.aclChecker.check(connectionId),
      this.healthGateService.evaluate(connectionId),
    ]);

    return {
      connectionId,
      provider: detectProvider(server, config?.host),
      acl,
      health,
      throughput: {
        opsPerSec,
        inputKbps,
        outputKbps,
        durationMs,
        estimatedLines,
        estimatedBytes,
      },
    };
  }
}

function readServerSection(info: unknown): Record<string, string | undefined> {
  const v = (info as { server?: Record<string, string | undefined> }).server;
  return v ?? {};
}

function readStatsSection(info: unknown): Record<string, string | undefined> {
  const v = (info as { stats?: Record<string, string | undefined> }).stats;
  return v ?? {};
}

function parseOptionalNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}
