#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initTelemetry, trackToolCall, stopTelemetry } from './telemetry.js';

// --- CLI arg parsing ---

const args = process.argv.slice(2);
const AUTOSTART = args.includes('--autostart');
const PERSIST   = args.includes('--persist');
const STOP      = args.includes('--stop');

function getArgValue(flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) {
    return args[i + 1];
  }
  return fallback;
}

const MONITOR_PORT    = Number(getArgValue('--port', '3001'));
const MONITOR_STORAGE = getArgValue('--storage', 'sqlite') as 'sqlite' | 'memory';

if (!Number.isFinite(MONITOR_PORT) || MONITOR_PORT < 1 || MONITOR_PORT > 65535) {
  console.error(`Invalid --port value. Must be a number between 1 and 65535.`);
  process.exit(1);
}

if (MONITOR_STORAGE !== 'sqlite' && MONITOR_STORAGE !== 'memory') {
  console.error(`Invalid --storage value "${MONITOR_STORAGE}". Must be sqlite or memory.`);
  process.exit(1);
}

// --- --stop: kill a persisted monitor and exit ---

if (STOP) {
  const { stopMonitor } = await import('./autostart.js');
  const result = await stopMonitor();
  console.error(result.message);
  process.exit(0);
}

let BETTERDB_URL = (process.env.BETTERDB_URL || 'http://localhost:3001').replace(/\/+$/, '');
const BETTERDB_TOKEN = process.env.BETTERDB_TOKEN;
const BETTERDB_INSTANCE_ID = process.env.BETTERDB_INSTANCE_ID || null;

let activeInstanceId: string | null = BETTERDB_INSTANCE_ID;

// Auto-detect whether the API lives at /api/* (production) or /* (local dev).
// Probe once on first request, then cache the result.
let detectedPrefix: string | null = null;
const API_PREFIXES = ['/api', ''];

async function rawFetch(prefix: string, path: string): Promise<Response> {
  const url = `${BETTERDB_URL}${prefix}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (BETTERDB_TOKEN) {
    headers['Authorization'] = `Bearer ${BETTERDB_TOKEN}`;
  }
  return fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
}

function isJsonResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json');
}

async function detectPrefix(): Promise<string> {
  for (const prefix of API_PREFIXES) {
    try {
      const res = await rawFetch(prefix, '/mcp/instances');
      if (res.ok && isJsonResponse(res)) {
        return prefix;
      }
    } catch {
      // network error — try next prefix
    }
  }
  // Fall back to /api if detection fails entirely
  return '/api';
}

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  if (detectedPrefix === null) {
    detectedPrefix = await detectPrefix();
  }
  const url = `${BETTERDB_URL}${detectedPrefix}${path}`;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (BETTERDB_TOKEN) {
    headers['Authorization'] = `Bearer ${BETTERDB_TOKEN}`;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 402) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    return {
      __licenseError: true,
      feature: data.feature ?? 'unknown',
      currentTier: data.currentTier ?? 'community',
      requiredTier: data.requiredTier ?? 'Pro or Enterprise',
      upgradeUrl: data.upgradeUrl ?? 'https://betterdb.com/pricing',
    };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let message = `Request failed with status ${res.status}`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error) message = String(parsed.error);
      else if (parsed.message) message = String(parsed.message);
    } catch {
      if (errText) message = errText;
    }
    throw new Error(message);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function apiFetch(path: string): Promise<unknown> {
  return apiRequest('GET', path);
}

function isLicenseError(data: unknown): data is { __licenseError: true; requiredTier: string; currentTier: string; upgradeUrl: string } {
  return data != null && typeof data === 'object' && (data as any).__licenseError === true;
}

function licenseErrorResult(data: { requiredTier: string; currentTier: string; upgradeUrl: string }): string {
  return `This feature requires a ${data.requiredTier} license (current tier: ${data.currentTier}). Upgrade at ${data.upgradeUrl}`;
}

const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function resolveInstanceId(overrideId?: string): string {
  const id = overrideId || activeInstanceId;
  if (!id) {
    throw new Error('No instance selected. Call list_instances then select_instance first.');
  }
  if (!INSTANCE_ID_RE.test(id)) {
    throw new Error(`Invalid instance ID: ${id}`);
  }
  return id;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function withTelemetry(toolName: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const start = Date.now();
  let success = true;
  let error: string | undefined;
  try {
    const result = await fn();
    if (result.isError) {
      success = false;
      error = result.content[0]?.text?.slice(0, 200);
    }
    return result;
  } catch (err) {
    success = false;
    error = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    throw err;
  } finally {
    trackToolCall({ toolName, success, durationMs: Date.now() - start, error });
  }
}

const server = new McpServer({
  name: 'betterdb',
  version: '0.1.0',
});

server.tool(
  'list_instances',
  'List all Valkey/Redis instances registered in BetterDB. Shows connection status and capabilities.',
  {},
  async () => withTelemetry('list_instances', async () => {
    const data = await apiFetch('/mcp/instances') as { instances: Array<{ id: string; name: string; isDefault: boolean; isConnected: boolean; [key: string]: unknown }> };
    const lines = data.instances.map((inst) => {
      const active = inst.id === activeInstanceId ? ' [ACTIVE]' : '';
      const status = inst.isConnected ? 'connected' : 'disconnected';
      return `${inst.id} - ${inst.name} (${status})${inst.isDefault ? ' [default]' : ''}${active}`;
    });
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') || 'No instances found.' }],
    };
  }),
);

server.tool(
  'select_instance',
  'Select which instance subsequent tool calls operate on.',
  { instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid instance ID format').describe('The instance ID to select') },
  async ({ instanceId }) => withTelemetry('select_instance', async () => {
    const data = await apiFetch('/mcp/instances') as { instances: Array<{ id: string; name: string }> };
    const found = data.instances.find((inst) => inst.id === instanceId);
    if (!found) {
      return {
        content: [{ type: 'text' as const, text: `Instance '${instanceId}' not found. Use list_instances to see available instances.` }],
        isError: true,
      };
    }
    activeInstanceId = instanceId;
    return {
      content: [{ type: 'text' as const, text: `Selected instance: ${found.name} (${instanceId})` }],
    };
  }),
);

// --- Connection management tools ---

server.tool(
  'add_connection',
  'Add a new Valkey/Redis connection to BetterDB. Optionally set it as the active default.',
  {
    name: z.string().describe('Display name for the connection'),
    host: z.string().describe('Hostname or IP address'),
    port: z.number().int().min(1).max(65535).default(6379).describe('Port number'),
    username: z.string().optional().describe('ACL username (default: "default")'),
    password: z.string().optional().describe('Auth password'),
    setAsDefault: z.boolean().optional().describe('Set this connection as the active default'),
  },
  async (params) => withTelemetry('add_connection', async () => {
    try {
      const data = await apiRequest('POST', '/connections', params) as { id: string };
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return {
        content: [{ type: 'text' as const, text: `Added connection: ${params.name} (${data.id})` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'test_connection',
  'Test a Valkey/Redis connection without persisting it. Use before add_connection to validate credentials.',
  {
    name: z.string().describe('Display name for the connection'),
    host: z.string().describe('Hostname or IP address'),
    port: z.number().int().min(1).max(65535).default(6379).describe('Port number'),
    username: z.string().optional().describe('ACL username (default: "default")'),
    password: z.string().optional().describe('Auth password'),
  },
  async (params) => withTelemetry('test_connection', async () => {
    try {
      const data = await apiRequest('POST', '/connections/test', params) as {
        success: boolean;
        capabilities?: unknown;
        error?: string;
      };
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      if (!data.success) {
        return {
          content: [{ type: 'text' as const, text: data.error ?? 'Connection test failed' }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: data.capabilities ? JSON.stringify(data.capabilities, null, 2) : 'Connection successful' }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'remove_connection',
  'Remove a connection from BetterDB.',
  {
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid instance ID format').describe('The instance ID to remove'),
  },
  async ({ instanceId }) => withTelemetry('remove_connection', async () => {
    try {
      const data = await apiRequest('DELETE', `/connections/${encodeURIComponent(instanceId)}`);
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return {
        content: [{ type: 'text' as const, text: `Removed connection: ${instanceId}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'set_default_connection',
  'Set a connection as the active default for BetterDB.',
  {
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid instance ID format').describe('The instance ID to set as default'),
  },
  async ({ instanceId }) => withTelemetry('set_default_connection', async () => {
    try {
      const data = await apiRequest('POST', `/connections/${encodeURIComponent(instanceId)}/default`);
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return {
        content: [{ type: 'text' as const, text: `Set as default: ${instanceId}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'get_info',
  'Get INFO stats for the active instance. Contains all health data: memory, clients, replication, keyspace, stats (hit rate, ops/sec), and server info. Optionally filter to a section: server|clients|memory|stats|replication|keyspace.',
  {
    section: z.string().optional().describe('INFO section to filter (server, clients, memory, stats, replication, keyspace)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ section, instanceId }) => withTelemetry('get_info', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/info`) as Record<string, unknown>;
    if (section && data[section] !== undefined) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ [section]: data[section] }, null, 2) }],
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_slowlog',
  'Get the most recent slow commands from the slowlog.',
  {
    count: z.number().optional().describe('Number of entries to return (default 25)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ count, instanceId }) => withTelemetry('get_slowlog', async () => {
    const id = resolveInstanceId(instanceId);
    const n = count ?? 25;
    const data = await apiFetch(`/mcp/instance/${id}/slowlog?count=${n}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_commandlog',
  'Get the most recent entries from COMMANDLOG (Valkey 8+ only, superset of slowlog).',
  {
    count: z.number().optional().describe('Number of entries to return (default 25)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ count, instanceId }) => withTelemetry('get_commandlog', async () => {
    const id = resolveInstanceId(instanceId);
    const n = count ?? 25;
    const data = await apiFetch(`/mcp/instance/${id}/commandlog?count=${n}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_latency',
  'Get latency event history for the active instance.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => withTelemetry('get_latency', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/latency`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_memory',
  'Get memory diagnostics: MEMORY DOCTOR assessment and MEMORY STATS breakdown.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => withTelemetry('get_memory', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/memory`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_clients',
  'Get the active client list with connection details.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => withTelemetry('get_clients', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/clients`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_health',
  'Get a synthetic health summary for the active instance: keyspace hit rate, memory fragmentation ratio, connected clients, replication lag (replicas only), and keyspace size. Use this as the first call when investigating an instance — it surfaces the most actionable signals without requiring you to parse raw INFO output.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => withTelemetry('get_health', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/health`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

// --- Historical data tools ---

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined) parts.push(`${key}=${encodeURIComponent(String(val))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

server.tool(
  'get_slowlog_patterns',
  'Get analyzed slowlog patterns from persisted storage. Groups slow commands by normalized pattern, showing frequency, average duration, and example commands. Survives slowlog buffer rotation — data goes back as far as BetterDB has been running.',
  {
    limit: z.number().optional().describe('Max entries to analyze'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ limit, instanceId }) => withTelemetry('get_slowlog_patterns', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ limit });
    const data = await apiFetch(`/mcp/instance/${id}/history/slowlog-patterns${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_commandlog_history',
  'Get persisted COMMANDLOG entries from storage (Valkey 8+ only). Supports time range filtering to investigate specific incidents. Returns empty with a note if COMMANDLOG is not supported on this instance.',
  {
    startTime: z.number().optional().describe('Start time (Unix timestamp ms)'),
    endTime: z.number().optional().describe('End time (Unix timestamp ms)'),
    command: z.string().optional().describe('Filter by command name'),
    minDuration: z.number().optional().describe('Min duration in microseconds'),
    limit: z.number().optional().describe('Max entries to return'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ startTime, endTime, command, minDuration, limit, instanceId }) => withTelemetry('get_commandlog_history', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ startTime, endTime, command, minDuration, limit });
    const data = await apiFetch(`/mcp/instance/${id}/history/commandlog${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_commandlog_patterns',
  'Get analyzed COMMANDLOG patterns from persisted storage (Valkey 8+ only). Like get_slowlog_patterns but includes large-request and large-reply patterns in addition to slow commands.',
  {
    startTime: z.number().optional().describe('Start time (Unix timestamp ms)'),
    endTime: z.number().optional().describe('End time (Unix timestamp ms)'),
    limit: z.number().optional().describe('Max entries to analyze'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ startTime, endTime, limit, instanceId }) => withTelemetry('get_commandlog_patterns', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ startTime, endTime, limit });
    const data = await apiFetch(`/mcp/instance/${id}/history/commandlog-patterns${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_anomalies',
  'Get anomaly detection events from persisted storage. BetterDB continuously runs Z-score analysis on memory, hit rate, CPU, and other metrics — this returns the detected anomalies. Use to investigate what triggered an alert or correlate with an incident.',
  {
    limit: z.number().optional().describe('Max events to return'),
    metricType: z.string().optional().describe('Filter by metric type'),
    startTime: z.number().optional().describe('Start time (Unix timestamp ms)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ limit, metricType, startTime, instanceId }) => withTelemetry('get_anomalies', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ limit, metricType, startTime });
    const data = await apiFetch(`/mcp/instance/${id}/history/anomalies${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_client_activity',
  'Get time-bucketed client activity from persisted snapshots. Shows connection counts, command distribution, and buffer usage over time. Use startTime/endTime to focus on a specific incident window.',
  {
    startTime: z.number().optional().describe('Start time (Unix timestamp ms)'),
    endTime: z.number().optional().describe('End time (Unix timestamp ms)'),
    bucketSizeMinutes: z.number().optional().describe('Bucket size in minutes (default 5)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ startTime, endTime, bucketSizeMinutes, instanceId }) => withTelemetry('get_client_activity', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ startTime, endTime, bucketSizeMinutes });
    const data = await apiFetch(`/mcp/instance/${id}/history/client-activity${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

// --- Hot keys ---

server.tool(
  'get_hot_keys',
  'Get hot key tracking data from persisted storage. BetterDB periodically scans keys using LFU frequency scores (when maxmemory-policy is an LFU variant) or OBJECT IDLETIME / COMMANDLOG-derived frequency. Each snapshot captures the top keys ranked by access frequency. Use this to find cache-busting keys, uneven access patterns, or keys that dominate throughput. The signalType field in each entry indicates which detection mode was active (lfu or idletime).',
  {
    startTime: z.number().optional().describe('Start time (Unix timestamp ms)'),
    endTime: z.number().optional().describe('End time (Unix timestamp ms)'),
    limit: z.number().optional().describe('Max entries to return (default 50, max 200)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ startTime, endTime, limit, instanceId }) => withTelemetry('get_hot_keys', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ startTime, endTime, limit });
    const data = await apiFetch(`/mcp/instance/${id}/hot-keys${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

// --- Cluster tools ---

server.tool(
  'get_cluster_nodes',
  'Discover all nodes in the Valkey cluster — role (master/replica), address, health status, and slot ranges. Returns an error message if this instance is not running in cluster mode.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => withTelemetry('get_cluster_nodes', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/cluster/nodes`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_cluster_node_stats',
  'Get per-node performance stats: memory usage, ops/sec, connected clients, replication offset, and CPU. Use this to identify hot nodes, lagging replicas, or uneven load distribution.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => withTelemetry('get_cluster_node_stats', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/cluster/node-stats`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_cluster_slowlog',
  'Get the aggregated slowlog across ALL nodes in the cluster. This is the primary tool for finding slow commands in cluster mode — per-node slowlogs are incomplete. Returns an error message if not in cluster mode.',
  {
    limit: z.number().optional().describe('Max entries to return (default 100)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ limit, instanceId }) => withTelemetry('get_cluster_slowlog', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ limit });
    const data = await apiFetch(`/mcp/instance/${id}/cluster/slowlog${qs}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

server.tool(
  'get_slot_stats',
  "Get per-slot key counts and CPU usage (Valkey 8.0+ only). Use orderBy='cpu-usec' to find hot slots, or 'key-count' to find the most populated slots. Returns an error message if not supported.",
  {
    orderBy: z.enum(['key-count', 'cpu-usec']).optional().describe("Sort order: 'key-count' or 'cpu-usec' (default 'key-count')"),
    limit: z.number().optional().describe('Max slots to return (default 20)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ orderBy, limit, instanceId }) => withTelemetry('get_slot_stats', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ orderBy, limit });
    const data = await apiFetch(`/mcp/instance/${id}/cluster/slot-stats${qs}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

// --- Latency history ---

server.tool(
  'get_latency_history',
  "Get the full latency history for a named event (e.g. 'command', 'fast-command'). Call get_latency first to see which event names are available, then use this to investigate a specific event's trend over time.",
  {
    eventName: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'Invalid event name').describe('Latency event name to query'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ eventName, instanceId }) => withTelemetry('get_latency_history', async () => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/latency/history/${encodeURIComponent(eventName)}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

// --- ACL audit ---

server.tool(
  'get_acl_audit',
  'Get persisted ACL audit log entries from storage. Filter by username, reason (auth, command, key, channel), or time range. Use this to investigate why a connection is failing or audit access patterns.',
  {
    username: z.string().optional().describe('Filter by username'),
    reason: z.string().optional().describe('Filter by reason (auth, command, key, channel)'),
    startTime: z.number().optional().describe('Start time (Unix timestamp ms)'),
    endTime: z.number().optional().describe('End time (Unix timestamp ms)'),
    limit: z.number().optional().describe('Max entries to return'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ username, reason, startTime, endTime, limit, instanceId }) => withTelemetry('get_acl_audit', async () => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ username, reason, startTime, endTime, limit });
    const data = await apiFetch(`/mcp/instance/${id}/audit${qs}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }),
);

// --- Monitor lifecycle tools ---

server.tool(
  'start_monitor',
  'Start the BetterDB monitor as a persistent background process. If already running, returns the existing URL. The monitor persists across MCP sessions and must be stopped explicitly with stop_monitor.',
  {
    port: z.number().int().min(1).max(65535).default(3001).describe('Port for the monitor API (default 3001)'),
    storage: z.enum(['sqlite', 'memory']).default('sqlite').describe('Storage backend (default sqlite)'),
  },
  async ({ port, storage }) => withTelemetry('start_monitor', async () => {
    try {
      const { startMonitor } = await import('./autostart.js');
      const result = await startMonitor({ persist: true, port, storage });
      BETTERDB_URL = result.url;
      process.env.BETTERDB_URL = result.url;
      detectedPrefix = null;
      const status = result.alreadyRunning ? 'Monitor already running' : 'Monitor started';
      return {
        content: [{ type: 'text' as const, text: `${status} at ${result.url}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to start monitor: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }),
);

const CACHE_NAME_DESC = "Cache name as registered in __betterdb:caches (e.g. 'betterdb_scache_prod').";

server.tool(
  'cache_list',
  'List all caches (semantic_cache and agent_cache) registered for the active instance, with hit rate and total ops.',
  {
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_list', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const data = await apiFetch(`/mcp/instance/${id}/caches`) as {
        caches: Array<{ name: string; type: string; hit_rate: number; total_ops: number; status: string }>;
      };
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      if (data.caches.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No caches registered for this instance.' }] };
      }
      const lines = data.caches.map((c) =>
        `${c.name} (${c.type}, ${c.status}) — hit rate ${(c.hit_rate * 100).toFixed(1)}%, ops ${c.total_ops}`,
      );
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_health',
  'Detailed health for a single cache. Response branches by type: semantic_cache reports category_breakdown + uncertain_hit_rate; agent_cache reports tool_breakdown.',
  {
    cache_name: z.string().min(1).describe(CACHE_NAME_DESC),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_health', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const data = await apiFetch(
        `/mcp/instance/${id}/caches/${encodeURIComponent(params.cache_name)}/health`,
      );
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_threshold_recommendation',
  'Threshold-tuning recommendation for a semantic_cache, based on the rolling similarity-score window. Errors with INVALID_CACHE_TYPE on agent_cache.',
  {
    cache_name: z.string().min(1).describe(CACHE_NAME_DESC),
    category: z.string().optional().describe('Restrict to a single category; omit for the global threshold'),
    minSamples: z.number().int().min(1).optional().describe('Minimum samples required (default 100)'),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_threshold_recommendation', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const qs = new URLSearchParams();
      if (params.category !== undefined) {
        qs.set('category', params.category);
      }
      if (params.minSamples !== undefined) {
        qs.set('minSamples', String(params.minSamples));
      }
      const path = `/mcp/instance/${id}/caches/${encodeURIComponent(params.cache_name)}/threshold-recommendation${qs.size > 0 ? `?${qs}` : ''}`;
      const data = await apiFetch(path);
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_tool_effectiveness',
  'Per-tool hit rate, cost saved, and TTL recommendation for an agent_cache. Errors with INVALID_CACHE_TYPE on semantic_cache.',
  {
    cache_name: z.string().min(1).describe(CACHE_NAME_DESC),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_tool_effectiveness', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const data = await apiFetch(
        `/mcp/instance/${id}/caches/${encodeURIComponent(params.cache_name)}/tool-effectiveness`,
      );
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_similarity_distribution',
  'Histogram of recent similarity scores (20 buckets, width 0.1) for a semantic_cache. Errors on agent_cache.',
  {
    cache_name: z.string().min(1).describe(CACHE_NAME_DESC),
    category: z.string().optional().describe('Restrict to a single category'),
    window_hours: z.number().int().min(1).max(168).optional().describe('Lookback window (default 24h, max 168h)'),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_similarity_distribution', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const qs = new URLSearchParams();
      if (params.category !== undefined) {
        qs.set('category', params.category);
      }
      if (params.window_hours !== undefined) {
        qs.set('windowHours', String(params.window_hours));
      }
      const path = `/mcp/instance/${id}/caches/${encodeURIComponent(params.cache_name)}/similarity-distribution${qs.size > 0 ? `?${qs}` : ''}`;
      const data = await apiFetch(path);
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_recent_changes',
  'Recent proposals for a single cache (any status), so agents can avoid re-proposing pending or recently-applied changes. Newest first.',
  {
    cache_name: z.string().min(1).describe(CACHE_NAME_DESC),
    limit: z.number().int().min(1).max(200).optional().describe('Max proposals to return (default 20, max 200)'),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_recent_changes', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const qs = params.limit !== undefined ? `?limit=${params.limit}` : '';
      const data = await apiFetch(
        `/mcp/instance/${id}/caches/${encodeURIComponent(params.cache_name)}/recent-changes${qs}`,
      );
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_propose_threshold_adjust',
  'Propose a semantic-cache similarity-threshold change for review. Creates a pending proposal that requires human approval before any change is applied. Reasoning must be at least 20 characters.',
  {
    cache_name: z.string().min(1).describe("Name of the semantic cache (e.g. 'betterdb_scache_prod')"),
    new_threshold: z.number().min(0).max(2).describe('Proposed cosine-distance threshold, 0–2'),
    category: z.string().nullable().optional().describe('Optional per-category override; null/undefined = global threshold'),
    reasoning: z.string().min(20).describe('Why the change is being proposed (≥20 chars)'),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_propose_threshold_adjust', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const data = await apiRequest('POST', `/mcp/instance/${id}/cache-proposals/threshold-adjust`, {
        cache_name: params.cache_name,
        new_threshold: params.new_threshold,
        category: params.category ?? null,
        reasoning: params.reasoning,
      }) as { proposal_id: string; status: string; expires_at: number; warnings: string[] };
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return formatProposalText(data);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_propose_tool_ttl_adjust',
  'Propose an agent-cache per-tool TTL change for review. Creates a pending proposal that requires human approval. Reasoning must be at least 20 characters.',
  {
    cache_name: z.string().min(1).describe("Name of the agent cache (e.g. 'betterdb_agentcache_prod')"),
    tool_name: z.string().min(1).describe('Tool whose TTL is being changed'),
    new_ttl_seconds: z.number().int().min(10).max(86400).describe('Proposed TTL in seconds (10–86400)'),
    reasoning: z.string().min(20).describe('Why the change is being proposed (≥20 chars)'),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_propose_tool_ttl_adjust', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const data = await apiRequest('POST', `/mcp/instance/${id}/cache-proposals/tool-ttl-adjust`, {
        cache_name: params.cache_name,
        tool_name: params.tool_name,
        new_ttl_seconds: params.new_ttl_seconds,
        reasoning: params.reasoning,
      }) as { proposal_id: string; status: string; expires_at: number; warnings: string[] };
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return formatProposalText(data);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

server.tool(
  'cache_propose_invalidate',
  'Propose a cache invalidation for review. Filter shape depends on cache type: semantic_cache requires filter_kind=valkey_search + filter_expression; agent_cache requires filter_kind in (tool|key_prefix|session) + filter_value. Warns when estimated_affected exceeds 10000.',
  {
    cache_name: z.string().min(1).describe('Name of the cache to invalidate'),
    filter_kind: z.enum(['valkey_search', 'tool', 'key_prefix', 'session']).describe('Discriminator: valkey_search for semantic_cache; tool|key_prefix|session for agent_cache'),
    filter_expression: z.string().min(1).optional().describe('Required when filter_kind=valkey_search; FT.SEARCH filter'),
    filter_value: z.string().min(1).optional().describe('Required when filter_kind in (tool|key_prefix|session); the matching value'),
    estimated_affected: z.number().int().min(0).describe('Caller-estimated number of affected entries'),
    reasoning: z.string().min(20).describe('Why the invalidation is being proposed (≥20 chars)'),
    instanceId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional().describe('Connection ID; defaults to the active instance'),
  },
  async (params) => withTelemetry('cache_propose_invalidate', async () => {
    try {
      const id = resolveInstanceId(params.instanceId);
      const body: Record<string, unknown> = {
        cache_name: params.cache_name,
        filter_kind: params.filter_kind,
        estimated_affected: params.estimated_affected,
        reasoning: params.reasoning,
      };
      if (params.filter_kind === 'valkey_search') {
        if (!params.filter_expression) {
          return {
            content: [{ type: 'text' as const, text: 'filter_expression is required when filter_kind=valkey_search' }],
            isError: true,
          };
        }
        body.filter_expression = params.filter_expression;
      } else {
        if (!params.filter_value) {
          return {
            content: [{ type: 'text' as const, text: `filter_value is required when filter_kind=${params.filter_kind}` }],
            isError: true,
          };
        }
        body.filter_value = params.filter_value;
      }
      const data = await apiRequest('POST', `/mcp/instance/${id}/cache-proposals/invalidate`, body) as { proposal_id: string; status: string; expires_at: number; warnings: string[] };
      if (isLicenseError(data)) {
        return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
      }
      return formatProposalText(data);
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }),
);

function formatProposalText(data: { proposal_id: string; status: string; expires_at: number; warnings: string[] }): ToolResult {
  const expiresAtIso = new Date(data.expires_at).toISOString();
  const lines = [
    `Proposal created: ${data.proposal_id}`,
    `Status: ${data.status}`,
    `Expires at: ${expiresAtIso}`,
  ];
  if (data.warnings && data.warnings.length > 0) {
    lines.push(`Warnings: ${data.warnings.join('; ')}`);
  }
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

server.tool(
  'stop_monitor',
  'Stop a persistent BetterDB monitor process that was previously started with start_monitor or --autostart --persist.',
  {},
  async () => withTelemetry('stop_monitor', async () => {
    try {
      const { stopMonitor } = await import('./autostart.js');
      const result = await stopMonitor();
      return {
        content: [{ type: 'text' as const, text: result.message }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to stop monitor: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }),
);

try {
  if (AUTOSTART) {
    const { startMonitor } = await import('./autostart.js');
    const result = await startMonitor({
      persist: PERSIST,
      port: MONITOR_PORT,
      storage: MONITOR_STORAGE,
    });
    // Always update URL/prefix to target the monitor (whether freshly started or already running)
    BETTERDB_URL = result.url;
    process.env.BETTERDB_URL = result.url;
    detectedPrefix = null;
  }

  initTelemetry(apiRequest);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopTelemetry();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error(`Failed to start MCP server: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
