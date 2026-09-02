import { Inject, Injectable } from '@nestjs/common';
import type { WorkspaceStatus } from '@betterdb/shared';
import { BETTER_AUTH, type BetterAuthInstance, countUsers } from '../auth/better-auth.factory';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '../auth/workspace-config';

export const WORKSPACE_STATUS = 'WORKSPACE_STATUS';

@Injectable()
export class WorkspaceStatusService {
  constructor(
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
    @Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance,
  ) {}

  async getStatus(): Promise<WorkspaceStatus> {
    const users = await countUsers(this.auth);
    return { mode: this.config.mode, enabled: this.config.enabled, bootstrapped: users > 0 };
  }
}
