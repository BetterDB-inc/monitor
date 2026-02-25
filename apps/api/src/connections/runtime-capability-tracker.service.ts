import { Injectable, Logger } from '@nestjs/common';
import { RuntimeCapabilities } from '@betterdb/shared';

const BLOCKED_COMMAND_PATTERNS = [
  /unknown command/i,
  /unknown subcommand/i,
  /NOPERM/i,
  /command is not allowed/i,
];

function isBlockedCommandError(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message;
  return BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(message));
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

@Injectable()
export class RuntimeCapabilityTracker {
  private readonly logger = new Logger(RuntimeCapabilityTracker.name);
  private capabilities = new Map<string, RuntimeCapabilities>();

  getCapabilities(connectionId: string): RuntimeCapabilities {
    return this.capabilities.get(connectionId) ?? defaultCapabilities();
  }

  isAvailable(
    connectionId: string,
    key: keyof RuntimeCapabilities,
  ): boolean {
    const caps = this.capabilities.get(connectionId);
    return caps ? caps[key] : true;
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

    if (caps[key]) {
      caps[key] = false;
      const message = typeof error === 'string' ? error : error.message;
      this.logger.warn(
        `Disabled capability '${key}' for connection ${connectionId}: ${message}`,
      );
    }

    return true;
  }

  resetConnection(connectionId: string): void {
    this.capabilities.delete(connectionId);
    this.logger.debug(
      `Reset runtime capabilities for connection ${connectionId}`,
    );
  }

  removeConnection(connectionId: string): void {
    this.capabilities.delete(connectionId);
  }
}
