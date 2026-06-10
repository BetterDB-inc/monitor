import type { StoredCommandCaptureSession } from '@betterdb/shared';
import { fetchApi } from './client';

export type { StoredCommandCaptureSession };

export interface StartCommandCaptureParams {
  connectionId: string;
  durationMs: number;
  commandCap?: number;
  createdBy?: string;
}

export const commandCaptureApi = {
  /** Get the active session for a connection (user-authed). */
  getSession: (connectionId: string): Promise<StoredCommandCaptureSession | null> => {
    return fetchApi<StoredCommandCaptureSession | null>(
      `/command-capture/session?connectionId=${encodeURIComponent(connectionId)}`,
    );
  },

  /** Start a command capture session. */
  start: (params: StartCommandCaptureParams): Promise<StoredCommandCaptureSession> => {
    return fetchApi<StoredCommandCaptureSession>('/command-capture/start', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  },

  /** Stop the active command capture session for a connection. */
  stop: (connectionId: string): Promise<{ stopped: boolean; session?: StoredCommandCaptureSession }> => {
    return fetchApi<{ stopped: boolean; session?: StoredCommandCaptureSession }>('/command-capture/stop', {
      method: 'POST',
      body: JSON.stringify({ connectionId }),
    });
  },
};
