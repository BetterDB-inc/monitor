import type { WorkspaceMode } from '@betterdb/shared';
import { DEFAULT_AUTH_BROKER_URL, isTrueFlag, normalizeOptionalUrl } from '../config/env-normalize';
import { trustsProxyHeaders } from '../config/trust-proxy';

export const WORKSPACE_CONFIG = 'WORKSPACE_CONFIG';

const VITE_DEV_ORIGIN = 'http://localhost:5173';

export interface WorkspaceConfig {
  enabled: boolean;
  mode: WorkspaceMode;
  publicUrl: string | null;
  basePath: string;
  brokerUrl: string;
  trustedOrigins: string[];
  trustProxy: boolean;
}

function resolveMode(env: NodeJS.ProcessEnv): WorkspaceMode {
  if (isTrueFlag(env.CLOUD_MODE)) {
    return 'cloud';
  }
  if (isTrueFlag(env.WORKSPACE_DISABLED)) {
    return 'disabled';
  }
  return 'self-hosted';
}

export function resolveWorkspaceConfig(env: NodeJS.ProcessEnv): WorkspaceConfig {
  const mode = resolveMode(env);
  const isProduction = env.NODE_ENV === 'production';
  const publicUrl = normalizeOptionalUrl(env.AUTH_PUBLIC_URL);
  const brokerUrl = normalizeOptionalUrl(env.AUTH_BROKER_URL);
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
    brokerUrl: brokerUrl ?? DEFAULT_AUTH_BROKER_URL,
    trustedOrigins,
    trustProxy: trustsProxyHeaders(env),
  };
}
