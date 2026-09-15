export type WorkspaceRole = 'admin' | 'member';

export type WorkspaceMode = 'disabled' | 'self-hosted' | 'cloud';

export type ActorVia = 'session' | 'token' | 'cli';

export interface Actor {
  userId: string;
  email: string;
  role: WorkspaceRole;
  isOwner: boolean;
  via: ActorVia;
  tokenId: string | null;
}

export interface WorkspaceStatus {
  mode: WorkspaceMode;
  enabled: boolean;
  bootstrapped: boolean;
}

export interface WorkspaceMe {
  userId: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  isOwner: boolean;
}
