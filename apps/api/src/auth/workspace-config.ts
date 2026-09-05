import type { WorkspaceMode } from '@betterdb/shared';
import { trustsProxyHeaders } from '../config/trust-proxy';

export const WORKSPACE_CONFIG = 'WORKSPACE_CONFIG';

const VITE_DEV_ORIGIN = 'http://localhost:5173';
const DEFAULT_BROKER_URL = 'https://betterdb.com';

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
  if (env.CLOUD_MODE === 'true') {
    return 'cloud';
  }
  if (env.WORKSPACE_DISABLED === 'true') {
    return 'disabled';
  }
  return 'self-hosted';
}

function resolveOptionalUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    return null;
  }
  return trimmed;
}

export function resolveWorkspaceConfig(env: NodeJS.ProcessEnv): WorkspaceConfig {
  const mode = resolveMode(env);
  const isProduction = env.NODE_ENV === 'production';
  const publicUrl = resolveOptionalUrl(env.AUTH_PUBLIC_URL);
  const brokerUrl = resolveOptionalUrl(env.AUTH_BROKER_URL);
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
    brokerUrl: brokerUrl ?? DEFAULT_BROKER_URL,
    trustedOrigins,
    trustProxy: trustsProxyHeaders(env),
  };
}
