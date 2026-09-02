import { Inject, Injectable } from '@nestjs/common';
import type { WorkspaceStatus } from '@betterdb/shared';
import { BETTER_AUTH, type BetterAuthInstance, countUsers } from '../auth/better-auth.factory';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '../auth/workspace-config';

export const WORKSPACE_STATUS = 'WORKSPACE_STATUS';

@Injectable()
export class WorkspaceStatusService {
  private bootstrapped = false;

  constructor(
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
    @Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance,
  ) {}

  async getStatus(): Promise<WorkspaceStatus> {
    const { mode, enabled } = this.config;
    if (this.bootstrapped === true) {
      return { mode, enabled, bootstrapped: true };
    }
    const users = await countUsers(this.auth);
    if (users > 0) {
      this.bootstrapped = true;
    }
    return { mode, enabled, bootstrapped: this.bootstrapped };
  }
}
