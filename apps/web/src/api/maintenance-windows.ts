import { fetchApi } from './client';
import type {
  CreateMaintenanceWindowRequest,
  MaintenanceWindowView,
  UpdateMaintenanceWindowRequest,
} from '@betterdb/shared';

export const maintenanceWindowsApi = {
  list: (signal?: AbortSignal) => fetchApi<MaintenanceWindowView[]>('/maintenance-windows', { signal }),
  create: (request: CreateMaintenanceWindowRequest) =>
    fetchApi<MaintenanceWindowView>('/maintenance-windows', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  update: (id: string, patch: UpdateMaintenanceWindowRequest) =>
    fetchApi<MaintenanceWindowView>(`/maintenance-windows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  end: (id: string) =>
    fetchApi<MaintenanceWindowView>(`/maintenance-windows/${encodeURIComponent(id)}/end`, { method: 'POST' }),
  remove: (id: string) =>
    fetchApi<void>(`/maintenance-windows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
