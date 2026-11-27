import { clusterName, pluginFetch } from './plugin-api';

// Client for the plugin backend (packages/agent, OpenEverest mode). The types
// mirror plugin-server.ts there.

export type TargetState = 'off' | 'connecting' | 'monitoring' | 'error';

export interface NodeStatus {
  id: string;
  name: string;
  address: string;
  role: 'primary' | 'replica';
  valkeyConnected: boolean;
  cloudConnected: boolean;
  /** Why this node is not streaming, when the backend knows. */
  error?: string;
}

export interface InstanceView {
  ref: { cluster: string; namespace: string; instance: string };
  enabled: boolean;
  status: {
    state: TargetState;
    error?: string;
    secretName: string | null;
    tls: boolean;
    nodes: NodeStatus[];
  };
  dashboardUrl: string | null;
}

export interface SettingsView {
  url: string;
  tokenSet: boolean;
  dashboardUrl: string | null;
  source: 'secret' | 'env' | 'none';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function request<T>(fetchImpl: Fetch, path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(path, { ...init, headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export function instancePath(namespace: string, instance: string, action: 'status' | 'enable' | 'disable', cluster = clusterName): string {
  return `/api/instances/${encodeURIComponent(cluster)}/${encodeURIComponent(namespace)}/${encodeURIComponent(instance)}/${action}`;
}

export const api = {
  status: (namespace: string, instance: string) =>
    request<InstanceView>(pluginFetch, instancePath(namespace, instance, 'status')),
  enable: (namespace: string, instance: string) =>
    request<InstanceView>(pluginFetch, instancePath(namespace, instance, 'enable'), { method: 'POST' }),
  disable: (namespace: string, instance: string) =>
    request<InstanceView>(pluginFetch, instancePath(namespace, instance, 'disable'), { method: 'POST' }),
  settings: () => request<SettingsView>(pluginFetch, '/api/settings'),
};
