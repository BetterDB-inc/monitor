import { Injectable, Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';

export interface AclCheckResult {
  /** Username we authenticated as (from `ACL WHOAMI`). */
  username: string;
  /** True if the user has the `monitor` command granted (directly or via a category). */
  hasMonitor: boolean;
  /** Exact `ACL SETUSER` snippet to grant +monitor when missing; absent when hasMonitor is true. */
  setUserSnippet?: string;
  /** Raw acl-rules string returned by the server, useful for debugging. */
  rawRules?: string;
}

/**
 * Probes the connection's ACL state to determine whether MONITOR is permitted.
 *
 * MONITOR is included in the `@dangerous` category, so any of the following
 * grants make it available:
 *  - `+monitor` (direct grant)
 *  - `+@all` without an explicit `-monitor`
 *  - `+@dangerous` without an explicit `-monitor`
 *  - the `allcommands` flag
 */
@Injectable()
export class AclChecker {
  private readonly logger = new Logger(AclChecker.name);

  constructor(private readonly connectionRegistry: ConnectionRegistry) {}

  async check(connectionId: string): Promise<AclCheckResult> {
    const client = this.connectionRegistry.get(connectionId);

    let username = 'default';
    try {
      const whoami = await callPort(client, 'ACL', ['WHOAMI']);
      if (typeof whoami === 'string') username = whoami;
    } catch (err) {
      this.logger.debug(`ACL WHOAMI failed on ${connectionId}: ${(err as Error).message}`);
      // Fall through with the assumed default user — ACL GETUSER may still succeed.
    }

    let raw: unknown;
    try {
      raw = await callPort(client, 'ACL', ['GETUSER', username]);
    } catch (err) {
      this.logger.debug(`ACL GETUSER ${username} failed on ${connectionId}: ${(err as Error).message}`);
      // If we cannot inspect, conservatively report no MONITOR access.
      return {
        username,
        hasMonitor: false,
        setUserSnippet: buildSnippet(username),
      };
    }

    const rules = extractRules(raw);
    const hasMonitor = grantsMonitor(rules);

    if (hasMonitor) {
      return { username, hasMonitor: true, rawRules: rules };
    }

    return {
      username,
      hasMonitor: false,
      setUserSnippet: buildSnippet(username),
      rawRules: rules,
    };
  }
}

interface DatabasePortLike {
  call(command: string, args: string[], options?: { cli?: boolean }): Promise<unknown>;
}

async function callPort(
  client: unknown,
  command: string,
  args: string[],
): Promise<unknown> {
  const c = client as DatabasePortLike;
  if (typeof c?.call !== 'function') {
    throw new Error('Database client does not expose call(command, args); cannot probe ACL');
  }
  return c.call(command, args);
}

/**
 * `ACL GETUSER` returns either:
 *  - a flat array of [key, value, key, value, ...] (RESP2)
 *  - a record/object (RESP3)
 * The "commands" field is a single string of space-separated rules.
 */
function extractRules(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.commands === 'string') return obj.commands;
  }
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length - 1; i += 2) {
      if (raw[i] === 'commands' && typeof raw[i + 1] === 'string') {
        return raw[i + 1] as string;
      }
    }
  }
  return '';
}

function grantsMonitor(rules: string): boolean {
  if (!rules) return false;

  const tokens = rules.split(/\s+/).filter(Boolean);

  // Explicit deny anywhere wins.
  if (tokens.includes('-monitor')) return false;

  if (tokens.includes('+monitor')) return true;
  if (tokens.includes('allcommands')) return true;
  if (tokens.includes('+@all')) return true;
  if (tokens.includes('+@dangerous')) return true;

  return false;
}

function buildSnippet(username: string): string {
  return `ACL SETUSER ${username} +monitor`;
}
