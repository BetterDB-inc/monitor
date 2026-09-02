import type { WorkspaceMode } from '@betterdb/shared';

export const WORKSPACE_CONFIG = 'WORKSPACE_CONFIG';

const VITE_DEV_ORIGIN = 'http://localhost:5173';

export interface WorkspaceConfig {
  enabled: boolean;
  mode: WorkspaceMode;
  publicUrl: string | null;
  basePath: string;
  brokerUrl: string;
  trustedOrigins: string[];
}

function resolveMode(env: NodeJS.ProcessEnv): WorkspaceMode {
  if (env.CLOUD_MODE === 'true') {
    return 'cloud';
  }
  if (env.WORKSPACE_DISABLED === 'true') {
    return 'disabled';
  }
  return 'self-hosted';
}

export function resolveWorkspaceConfig(env: NodeJS.ProcessEnv): WorkspaceConfig {
  const mode = resolveMode(env);
  const isProduction = env.NODE_ENV === 'production';
  const publicUrl = env.AUTH_PUBLIC_URL ? env.AUTH_PUBLIC_URL.replace(/\/+$/, '') : null;
  const trustedOrigins: string[] = [];
  if (publicUrl !== null) {
    trustedOrigins.push(publicUrl);
  }
  if (isProduction === false) {
    trustedOrigins.push(VITE_DEV_ORIGIN);
  }
  return {
    enabled: mode === 'self-hosted',
    mode,
    publicUrl,
    basePath: isProduction ? '/api/auth' : '/auth',
    brokerUrl: env.AUTH_BROKER_URL ?? 'https://betterdb.com',
    trustedOrigins,
  };
}
