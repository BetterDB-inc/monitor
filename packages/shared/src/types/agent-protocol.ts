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

/**
 * Where a multi-target agent found the database it relays. Sent by the agent's
 * OpenEverest mode, where one process streams many Valkey nodes over one token.
 * The cloud derives the connection id from these labels instead of the token,
 * so each node keeps its history across agent restarts and failovers.
 */
export interface AgentIdentity {
  platform: 'openeverest';
  /** Kubernetes cluster id (the kube-system namespace UID), when the agent could read it. */
  clusterId?: string;
  /** OpenEverest cluster name, as in the plugin URL (`main` for the local cluster). */
  cluster: string;
  namespace: string;
  instance: string;
  /** Stable node key within the instance: the cluster node id, or host:port when standalone. */
  node: string;
  /** Readable node name (the pod name), used for the connection name. */
  nodeName?: string;
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
    serverless?: boolean;
  };
  /**
   * Optional. Older agent versions do not send this field; the cloud should
   * treat absence as "password" for display purposes.
   */
  authMode?: AuthMode;
  /** Optional. Absent from single-target agents, which are identified by their token. */
  identity?: AgentIdentity;
  /**
   * Optional. True when the agent holds credentials it must not change state
   * with (OpenEverest hands out the admin user). The cloud refuses CLIENT KILL,
   * the RESET sub-commands, CONFIG SET and the like on such connections.
   */
  readOnly?: boolean;
}

/**
 * Cloud → Agent, right after the hello was accepted and the connection
 * registered. Lets a multi-target agent tell that the server understood its
 * identity: a server from before this message registers every node under
 * the token's id, and the agent reports it rather than fight itself.
 * Older servers never send it; older agents ignore it.
 */
export interface AgentWelcomeMessage {
  type: 'welcome';
  serverVersion: string;
  /** The server derived the connection id from hello.identity. */
  identity: boolean;
  /** The server enforces read-only on this connection. */
  readOnly: boolean;
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
  | AgentWelcomeMessage
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
  userId: string | null;
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
  /** Optional; present for multi-target agents (see AgentIdentity). */
  identity?: AgentIdentity;
  /** Optional; true when state-changing actions are refused on this connection. */
  readOnly?: boolean;
}
