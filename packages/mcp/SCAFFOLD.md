# Task: scaffold `packages/mcp` - BetterDB MCP server

## Context

This is a pnpm monorepo (`pnpm-workspace.yaml` globs `packages/*`). Existing packages: `packages/shared`, `packages/agent`, `packages/cli`. The new package lives at `packages/mcp`.

The MCP server connects to the BetterDB monitor's existing REST API (default `http://localhost:3001`). Auth reuses the existing agent-token mechanism (see below). Do NOT touch any existing packages or apps except where noted.

---

## 1. Package scaffold

Create `packages/mcp/package.json`:

```json
{
  "name": "@betterdb/mcp",
  "version": "0.1.0",
  "description": "BetterDB MCP server - Valkey observability for Claude Code and other MCP clients",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "betterdb-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@betterdb/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "^20.0.0"
  },
  "engines": { "node": ">=20.0.0" }
}
```

Create `packages/mcp/tsconfig.json` mirroring the pattern in `packages/agent/tsconfig.json` (target ES2022, moduleResolution bundler or node16, outDir dist, rootDir src, strict true).

---

## 2. Auth model - reuse agent tokens over HTTP

The agent token system already exists in `proprietary/agent/agent-tokens.service.ts`. The MCP server authenticates to the monitor's HTTP API using the same JWT token - no new token type needed.

**How it works at runtime:**
- User generates a token in the BetterDB UI (same "Via Agent" tab, or a new "MCP" tab - UI change is OUT OF SCOPE for this task).
- Token is set as env var `BETTERDB_TOKEN` for the MCP server.
- Every HTTP request from the MCP server to the monitor includes `Authorization: Bearer <token>`.

**What needs to change in `apps/api`:**

Add `apps/api/src/common/guards/agent-token.guard.ts`:

```typescript
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AgentTokensService } from '../../../../proprietary/agent/agent-tokens.service';
import { FastifyRequest } from 'fastify';

@Injectable()
export class AgentTokenGuard implements CanActivate {
  constructor(private readonly tokenService: AgentTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const auth = req.headers['authorization'];
    const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!raw) throw new UnauthorizedException();
    const result = await this.tokenService.validateToken(raw);
    if (!result.valid) throw new UnauthorizedException();
    return true;
  }
}
```

Apply the guard to the MCP-facing routes only (NOT to all connections routes, to avoid breaking existing usage). We will add a dedicated MCP controller at `apps/api/src/mcp/mcp.controller.ts` (see section 4) that uses `@UseGuards(AgentTokenGuard)`.

Make sure `AgentTokensService` and `AgentTokensModule` (or whichever module owns it in `proprietary/agent`) is exported and importable from `apps/api/src/mcp/mcp.module.ts`. Check how it is currently imported in the agent gateway module and replicate that import pattern. Do NOT change the existing agent gateway or token service.

---

## 3. MCP-facing API controller

Create `apps/api/src/mcp/mcp.controller.ts` with `@UseGuards(AgentTokenGuard)` on the controller class.

Expose these endpoints (all GET, all protected):

```
GET /mcp/instances
  -> returns registry.list() shaped as:
     { instances: [{ id, name, host, port, isDefault, isConnected, capabilities }] }

GET /mcp/instance/:id/info
  -> runs INFO ALL on the specified connection, returns parsed key sections
     (server, clients, memory, stats, replication, keyspace)

GET /mcp/instance/:id/slowlog?count=25
  -> returns last N slowlog entries

GET /mcp/instance/:id/latency
  -> returns LATENCY LATEST output

GET /mcp/instance/:id/memory
  -> returns MEMORY DOCTOR + MEMORY STATS output

GET /mcp/instance/:id/commandlog?count=25
  -> returns last N COMMANDLOG entries (guard with try/catch, return empty + note if not supported)

GET /mcp/instance/:id/clients
  -> returns CLIENT LIST parsed

GET /mcp/instance/:id/health
  -> synthetic health summary: hit rate, memory fragmentation ratio, connected clients,
     replication lag (if replica), keyspace size. Derive from INFO ALL.
```

Use the existing `ConnectionRegistry` (already `@Global`) - inject it, call `registry.get(id)` to get the `DatabasePort`, then issue commands directly. Pattern is identical to existing service pollers. Do not add new storage, do not persist anything.

Create `apps/api/src/mcp/mcp.module.ts` - import `ConnectionsModule`, `AgentTokensModule` (or whichever module provides `AgentTokensService`), provide `AgentTokenGuard`, declare and export `McpController`.

Register `McpModule` in `apps/api/src/app.module.ts` imports array.

---

## 4. MCP server package (`packages/mcp/src/index.ts`)

The MCP server is a stdio MCP server using `@modelcontextprotocol/sdk`. It exposes tools that proxy to the BetterDB monitor HTTP API.

Config (read from env):
- `BETTERDB_URL` - monitor base URL, default `http://localhost:3001`
- `BETTERDB_TOKEN` - agent token (required)
- `BETTERDB_INSTANCE_ID` - optional default instance ID (overridden per-call by `select_instance`)

Session state: a single `activeInstanceId: string | null` variable. Initialized from `BETTERDB_INSTANCE_ID` if set.

**Helper:** `apiFetch(path: string)` - fetches `${BETTERDB_URL}${path}` with `Authorization: Bearer ${BETTERDB_TOKEN}`, throws on non-2xx with the response body as the error message.

**Tools to register:**

```
list_instances
  description: "List all Valkey/Redis instances registered in BetterDB. Shows connection status and capabilities."
  input: {}
  handler: GET /mcp/instances
           Also note which one is currently active (activeInstanceId).

select_instance
  description: "Select which instance subsequent tool calls operate on."
  input: { instanceId: string }
  handler: verify instanceId exists in list_instances response, set activeInstanceId, return confirmation.

get_health
  description: "Get a health summary for the active instance: hit rate, memory fragmentation, connected clients, replication lag."
  input: { instanceId?: string }  // optional override
  handler: GET /mcp/instance/:id/health

get_info
  description: "Get raw INFO stats for the active instance. Optionally filter to a section: server|clients|memory|stats|replication|keyspace"
  input: { section?: string, instanceId?: string }
  handler: GET /mcp/instance/:id/info, filter section client-side if provided

get_slowlog
  description: "Get the most recent slow commands from the slowlog."
  input: { count?: number, instanceId?: string }
  handler: GET /mcp/instance/:id/slowlog?count=N

get_commandlog
  description: "Get the most recent entries from COMMANDLOG (Valkey 8+ only, superset of slowlog)."
  input: { count?: number, instanceId?: string }
  handler: GET /mcp/instance/:id/commandlog?count=N

get_latency
  description: "Get latency event history for the active instance."
  input: { instanceId?: string }
  handler: GET /mcp/instance/:id/latency

get_memory
  description: "Get memory diagnostics: MEMORY DOCTOR assessment and MEMORY STATS breakdown."
  input: { instanceId?: string }
  handler: GET /mcp/instance/:id/memory

get_clients
  description: "Get the active client list with connection details."
  input: { instanceId?: string }
  handler: GET /mcp/instance/:id/clients
```

For all tools with `instanceId?: string`: use `instanceId ?? activeInstanceId`. If both are null, return a tool error: "No instance selected. Call list_instances then select_instance first."

---

## 5. Verify

After scaffolding, run `tsc --noEmit` in `packages/mcp` and `apps/api`. Fix any type errors. Do not change `tsc` configs in any other package.
