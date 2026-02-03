import { fetchApi } from './client';
import type { VersionInfo } from '@betterdb/shared';

export const versionApi = {
  async getVersion(): Promise<VersionInfo> {
    return fetchApi<VersionInfo>('/version');
  },
};
