import { fetchApi } from './client';
import type { LogCaptureSummary } from '@betterdb/shared';

export const logCaptureApi = {
  getSummary: (signal?: AbortSignal, windowHours = 24) =>
    fetchApi<LogCaptureSummary>(`/log-capture/summary?windowHours=${windowHours}`, { signal }),
};
