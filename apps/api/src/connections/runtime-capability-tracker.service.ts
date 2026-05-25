import { Injectable, Logger } from '@nestjs/common';
import { RuntimeCapabilities } from '@betterdb/shared';

/**
 * Cheapest read-only command per capability used to probe whether the
 * server actually allows it. Surfaced for ConnectionsController so retry
 * can run the probe synchronously instead of relying on the next poll
 * cycle.
 */
export const CAPABILITY_TEST_COMMAND: Record<keyof RuntimeCapabilities, [string, ...string[]]> = {
  // Use the same SLOWLOG GET path the live poller / UI uses so a server that
  // permits LEN but blocks GET (Upstash et al.) can't pass the probe and then
  // fail on the next poll. LIMIT 1 keeps the cost negligible.
  canSlowLog: ['SLOWLOG', 'GET', '1'],
  canCommandLog: ['COMMANDLOG', 'LEN', 'slow'],
  canLatency: ['LATENCY', 'LATEST'],
  // CLIENT GETNAME is O(1) and exercises the same ACL gate as CLIENT LIST
  // without scanning the connection table.
  canClientList: ['CLIENT', 'GETNAME'],
  canAclLog: ['ACL', 'LOG', '1'],
  canClusterInfo: ['CLUSTER', 'INFO'],
  // Match the shape used by the live poller (unified.adapter.ts) so a
  // server that accepts the polled call also accepts the probe.
  canClusterSlotStats: ['CLUSTER', 'SLOT-STATS', 'ORDERBY', 'key-count', 'LIMIT', '1'],
  canMemory: ['MEMORY', 'STATS'],
};

const BLOCKED_COMMAND_PATTERNS = [
  /unknown command/i,
  /unknown subcommand/i,
  /NOPERM/i,
  /command is not allowed/i,
  // Upstash returns "ERR Command is not available: '<COMMAND>'" for unsupported commands
  /command is not available/i,
  /command .* not supported/i,
  // Standalone Valkey/Redis on cluster-only commands (CLUSTER SLOT-STATS etc.)
  /cluster support disabled/i,
];

function isBlockedCommandError(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message;
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => {
    return pattern.test(message);
  });
}

function defaultCapabilities(): RuntimeCapabilities {
  return {
    canSlowLog: true,
    canClientList: true,
    canAclLog: true,
    canClusterInfo: true,
    canClusterSlotStats: true,
    canCommandLog: true,
    canLatency: true,
    canMemory: true,
  };
}

/**
 * Per-capability metadata describing why it was disabled and when.
 */
export interface CapabilityDisabledInfo {
  reason: string;
  disabledAt: number;
}

@Injectable()
export class RuntimeCapabilityTracker {
  private readonly logger = new Logger(RuntimeCapabilityTracker.name);
  private capabilities = new Map<string, RuntimeCapabilities>();
  private disabledReasons = new Map<string, Map<keyof RuntimeCapabilities, CapabilityDisabledInfo>>();

  getCapabilities(connectionId: string): RuntimeCapabilities {
    return this.capabilities.get(connectionId) ?? defaultCapabilities();
  }

  /**
   * Get the reason a capability is disabled (if disabled), keyed by capability.
   */
  getDisabledReasons(connectionId: string): Record<string, CapabilityDisabledInfo> {
    const map = this.disabledReasons.get(connectionId);
    if (!map) {
      return {};
    }
    const out: Record<string, CapabilityDisabledInfo> = {};
    for (const [key, info] of map.entries()) {
      out[key] = info;
    }
    return out;
  }

  isAvailable(connectionId: string, key: keyof RuntimeCapabilities): boolean {
    const caps = this.capabilities.get(connectionId);
    if (!caps) {
      return true;
    }
    return caps[key];
  }

  /**
   * Record a command failure. Returns true if the error matched blocked-command
   * patterns (and the capability was disabled). Returns false for transient
   * errors (timeout, connection lost) — caller should handle normally.
   */
  recordFailure(
    connectionId: string,
    key: keyof RuntimeCapabilities,
    error: Error | string,
  ): boolean {
    if (!isBlockedCommandError(error)) {
      return false;
    }

    let caps = this.capabilities.get(connectionId);
    if (!caps) {
      caps = defaultCapabilities();
      this.capabilities.set(connectionId, caps);
    }

    const message = typeof error === 'string' ? error : error.message;

    if (caps[key]) {
      caps[key] = false;
      this.logger.warn(`Disabled capability '${key}' for connection ${connectionId}: ${message}`);
    }

    let reasons = this.disabledReasons.get(connectionId);
    if (!reasons) {
      reasons = new Map();
      this.disabledReasons.set(connectionId, reasons);
    }
    reasons.set(key, { reason: message, disabledAt: Date.now() });

    return true;
  }

  /**
   * Re-enable a single capability so the next poll will retry the command.
   * Used by the UI to manually retry after the operator has (presumably) fixed
   * the underlying issue on the database side.
   */
  resetCapability(connectionId: string, key: keyof RuntimeCapabilities): void {
    const caps = this.capabilities.get(connectionId);
    if (caps) {
      caps[key] = true;
    }
    const reasons = this.disabledReasons.get(connectionId);
    if (reasons) {
      reasons.delete(key);
      if (reasons.size === 0) {
        this.disabledReasons.delete(connectionId);
      }
    }
    this.logger.log(`Reset capability '${key}' for connection ${connectionId}`);
  }

  resetConnection(connectionId: string): void {
    this.capabilities.delete(connectionId);
    this.disabledReasons.delete(connectionId);
    this.logger.debug(`Reset runtime capabilities for connection ${connectionId}`);
  }

  removeConnection(connectionId: string): void {
    this.capabilities.delete(connectionId);
    this.disabledReasons.delete(connectionId);
  }
}
