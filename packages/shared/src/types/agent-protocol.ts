/**
 * How the agent authenticates to the underlying Valkey/Redis instance.
 * "password" covers all static-credential modes (AUTH token, ACL password).
 * "elasticache-iam" indicates the agent is minting short-lived SigV4-signed
 * tokens against AWS credentials and rotating them on every reconnect.
 */
export type AuthMode = 'password' | 'elasticache-iam';

// Cloud → Agent
export interface AgentCommandMessage {
  id: string;
  type: 'command';
  cmd: string;
  args?: string[];
  binaryArgs?: Record<string, string>; // placeholder → base64-encoded binary
  cli?: boolean; // true when command originates from the in-browser CLI
}

// Agent → Cloud
export interface AgentResponseMessage {
  id: string;
  type: 'response';
  data: unknown;
  binary?: boolean; // true when data is base64-encoded binary
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
  /**
   * Optional. Older agent versions do not send this field; the cloud should
   * treat absence as "password" for display purposes.
   */
  authMode?: AuthMode;
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
export type TokenType = 'agent' | 'mcp';

export interface AgentToken {
  id: string;
  name: string;
  type: TokenType;
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
  /** Optional; absent when the agent did not report it (older versions). */
  authMode?: AuthMode;
}
