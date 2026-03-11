#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BETTERDB_URL = (process.env.BETTERDB_URL || 'http://localhost:3001').replace(/\/+$/, '');
const BETTERDB_TOKEN = process.env.BETTERDB_TOKEN;
const BETTERDB_INSTANCE_ID = process.env.BETTERDB_INSTANCE_ID || null;

let activeInstanceId: string | null = BETTERDB_INSTANCE_ID;

if (!BETTERDB_TOKEN) {
  console.error('BETTERDB_TOKEN environment variable is required');
  process.exit(1);
}

async function apiFetch(path: string): Promise<unknown> {
  const url = `${BETTERDB_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${BETTERDB_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 402) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return {
      __licenseError: true,
      feature: body.feature ?? 'unknown',
      currentTier: body.currentTier ?? 'community',
      requiredTier: body.requiredTier ?? 'Pro or Enterprise',
      upgradeUrl: body.upgradeUrl ?? 'https://betterdb.com/pricing',
    };
  }

  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }

  return res.json();
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

const server = new McpServer({
  name: 'betterdb',
  version: '0.1.0',
});

server.tool(
  'list_instances',
  'List all Valkey/Redis instances registered in BetterDB. Shows connection status and capabilities.',
  {},
  async () => {
    const data = await apiFetch('/mcp/instances') as { instances: Array<{ id: string; name: string; isDefault: boolean; isConnected: boolean; [key: string]: unknown }> };
    const lines = data.instances.map((inst) => {
      const active = inst.id === activeInstanceId ? ' [ACTIVE]' : '';
      const status = inst.isConnected ? 'connected' : 'disconnected';
      return `${inst.id} - ${inst.name} (${status})${inst.isDefault ? ' [default]' : ''}${active}`;
    });
    return {
      content: [{ type: 'text' as const, text: lines.join('\n') || 'No instances found.' }],
    };
  },
);

server.tool(
  'select_instance',
  'Select which instance subsequent tool calls operate on.',
  { instanceId: z.string().describe('The instance ID to select') },
  async ({ instanceId }) => {
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
  },
);

server.tool(
  'get_health',
  'Get a health summary for the active instance: hit rate, memory fragmentation, connected clients, replication lag.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/health`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_info',
  'Get raw INFO stats for the active instance. Optionally filter to a section: server|clients|memory|stats|replication|keyspace',
  {
    section: z.string().optional().describe('INFO section to filter (server, clients, memory, stats, replication, keyspace)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ section, instanceId }) => {
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
  },
);

server.tool(
  'get_slowlog',
  'Get the most recent slow commands from the slowlog.',
  {
    count: z.number().optional().describe('Number of entries to return (default 25)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ count, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const n = count ?? 25;
    const data = await apiFetch(`/mcp/instance/${id}/slowlog?count=${n}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_commandlog',
  'Get the most recent entries from COMMANDLOG (Valkey 8+ only, superset of slowlog).',
  {
    count: z.number().optional().describe('Number of entries to return (default 25)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ count, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const n = count ?? 25;
    const data = await apiFetch(`/mcp/instance/${id}/commandlog?count=${n}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_latency',
  'Get latency event history for the active instance.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/latency`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_memory',
  'Get memory diagnostics: MEMORY DOCTOR assessment and MEMORY STATS breakdown.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/memory`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_clients',
  'Get the active client list with connection details.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/clients`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
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
  async ({ limit, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ limit });
    const data = await apiFetch(`/mcp/instance/${id}/history/slowlog-patterns${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_commandlog_history',
  'Get persisted COMMANDLOG entries from storage (Valkey 8+ only). Supports time range filtering to investigate specific incidents. Returns empty with a note if COMMANDLOG is not supported on this instance.',
  {
    startTime: z.number().optional().describe('Start time (Unix timestamp in seconds)'),
    endTime: z.number().optional().describe('End time (Unix timestamp in seconds)'),
    command: z.string().optional().describe('Filter by command name'),
    minDuration: z.number().optional().describe('Min duration in microseconds'),
    limit: z.number().optional().describe('Max entries to return'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ startTime, endTime, command, minDuration, limit, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ startTime, endTime, command, minDuration, limit });
    const data = await apiFetch(`/mcp/instance/${id}/history/commandlog${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_commandlog_patterns',
  'Get analyzed COMMANDLOG patterns from persisted storage (Valkey 8+ only). Like get_slowlog_patterns but includes large-request and large-reply patterns in addition to slow commands.',
  {
    startTime: z.number().optional().describe('Start time (Unix timestamp in seconds)'),
    endTime: z.number().optional().describe('End time (Unix timestamp in seconds)'),
    limit: z.number().optional().describe('Max entries to analyze'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ startTime, endTime, limit, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ startTime, endTime, limit });
    const data = await apiFetch(`/mcp/instance/${id}/history/commandlog-patterns${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
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
  async ({ limit, metricType, startTime, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ limit, metricType, startTime });
    const data = await apiFetch(`/mcp/instance/${id}/history/anomalies${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
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
  async ({ startTime, endTime, bucketSizeMinutes, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ startTime, endTime, bucketSizeMinutes });
    const data = await apiFetch(`/mcp/instance/${id}/history/client-activity${qs}`);
    if (isLicenseError(data)) {
      return { content: [{ type: 'text' as const, text: licenseErrorResult(data) }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// --- Cluster tools ---

server.tool(
  'get_cluster_nodes',
  'Discover all nodes in the Valkey cluster — role (master/replica), address, health status, and slot ranges. Returns an error message if this instance is not running in cluster mode.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/cluster/nodes`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_cluster_node_stats',
  'Get per-node performance stats: memory usage, ops/sec, connected clients, replication offset, and CPU. Use this to identify hot nodes, lagging replicas, or uneven load distribution.',
  { instanceId: z.string().optional().describe('Optional instance ID override') },
  async ({ instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/cluster/node-stats`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_cluster_slowlog',
  'Get the aggregated slowlog across ALL nodes in the cluster. This is the primary tool for finding slow commands in cluster mode — per-node slowlogs are incomplete. Returns an error message if not in cluster mode.',
  {
    limit: z.number().optional().describe('Max entries to return (default 100)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ limit, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ limit });
    const data = await apiFetch(`/mcp/instance/${id}/cluster/slowlog${qs}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

server.tool(
  'get_slot_stats',
  "Get per-slot key counts and CPU usage (Valkey 8.0+ only). Use orderBy='cpu-usec' to find hot slots, or 'key-count' to find the most populated slots. Returns an error message if not supported.",
  {
    orderBy: z.enum(['key-count', 'cpu-usec']).optional().describe("Sort order: 'key-count' or 'cpu-usec' (default 'key-count')"),
    limit: z.number().optional().describe('Max slots to return (default 20)'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ orderBy, limit, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ orderBy, limit });
    const data = await apiFetch(`/mcp/instance/${id}/cluster/slot-stats${qs}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

// --- Latency history ---

server.tool(
  'get_latency_history',
  "Get the full latency history for a named event (e.g. 'command', 'fast-command'). Call get_latency first to see which event names are available, then use this to investigate a specific event's trend over time.",
  {
    eventName: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'Invalid event name').describe('Latency event name to query'),
    instanceId: z.string().optional().describe('Optional instance ID override'),
  },
  async ({ eventName, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const data = await apiFetch(`/mcp/instance/${id}/latency/history/${encodeURIComponent(eventName)}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
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
  async ({ username, reason, startTime, endTime, limit, instanceId }) => {
    const id = resolveInstanceId(instanceId);
    const qs = buildQuery({ username, reason, startTime, endTime, limit });
    const data = await apiFetch(`/mcp/instance/${id}/audit${qs}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  },
);

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error(`Failed to start MCP server: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
