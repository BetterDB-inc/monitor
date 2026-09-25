import { fetchApi } from './client';
import type { FleetSummaryResponse } from '@betterdb/shared';

export const fleetApi = {
  getSummary: (signal?: AbortSignal) =>
    fetchApi<FleetSummaryResponse>('/fleet/summary', { signal }),
};
