// Cloud → Agent
export interface AgentCommandMessage {
  id: string;
  type: 'command';
  cmd: string;
  args?: string[];
}

// Agent → Cloud
export interface AgentResponseMessage {
  id: string;
  type: 'response';
  data: unknown;
}

export interface AgentErrorMessage {
  id: string;
  type: 'error';
  error: string;
}

// Agent → Cloud (on initial connection)
export interface AgentHelloMessage {
  type: 'agent_hello';
  version: string;
  capabilities: string[];
  valkey: {
    type: 'valkey' | 'redis';
    version: string;
    tls: boolean;
    cluster: boolean;
  };
}

// Bidirectional heartbeat
export interface AgentPingMessage {
  type: 'ping';
  ts: number;
}

export interface AgentPongMessage {
  type: 'pong';
  ts: number;
}

export type AgentMessage =
  | AgentCommandMessage
  | AgentResponseMessage
  | AgentErrorMessage
  | AgentHelloMessage
  | AgentPingMessage
  | AgentPongMessage;

// Agent token metadata (stored in DB, returned by API)
export interface AgentToken {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

// Agent connection info (live WS connections)
export interface AgentConnectionInfo {
  id: string;
  tokenId: string;
  name: string;
  connectedAt: number;
  agentVersion: string;
  valkey: {
    type: 'valkey' | 'redis';
    version: string;
    tls: boolean;
    cluster: boolean;
  };
}
