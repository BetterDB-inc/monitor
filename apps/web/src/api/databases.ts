import { fetchApi } from './client';

export type DatabaseStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'error'
  | 'suspended'
  | 'deleting';

export interface Database {
  id: string;
  name: string;
  status: DatabaseStatus;
  statusMessage: string | null;
  host: string | null;
  port: number;
  username: string;
  maxmemory: string | null;
  createdAt: string;
}

export interface DatabaseCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export const databasesApi = {
  list: () => fetchApi<Database[]>('/workspace/databases'),
  create: (data: { name: string; maxmemory?: string }) =>
    fetchApi<Database>('/workspace/databases', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  credentials: (id: string) =>
    fetchApi<DatabaseCredentials>(`/workspace/databases/${id}/credentials`),
  remove: (id: string) =>
    fetchApi<void>(`/workspace/databases/${id}`, { method: 'DELETE' }),
};
