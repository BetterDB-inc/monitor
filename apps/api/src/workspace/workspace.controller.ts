import { Controller, Get, Inject } from '@nestjs/common';
import type { Actor, WorkspaceMe } from '@betterdb/shared';
import { BETTER_AUTH, type BetterAuthInstance } from '../auth/better-auth.factory';
import { CurrentUser } from '../auth/guards/current-user.decorator';

interface StoredUser {
  id: string;
  email: string;
  name: string | null;
}

@Controller('workspace')
export class WorkspaceController {
  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  @Get('me')
  async getMe(@CurrentUser() actor: Actor): Promise<WorkspaceMe> {
    const context = await this.auth.$context;
    const user = (await context.adapter.findOne({
      model: 'user',
      where: [{ field: 'id', value: actor.userId }],
    })) as StoredUser | null;
    return {
      userId: actor.userId,
      email: actor.email,
      name: user?.name ?? null,
      role: actor.role,
      isOwner: actor.isOwner,
    };
  }
}
