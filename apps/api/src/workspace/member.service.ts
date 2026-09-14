import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { WorkspaceRole } from '@betterdb/shared';
import { BETTER_AUTH, type BetterAuthInstance } from '../auth/better-auth.factory';

export const OWNERSHIP_CHANGED_MESSAGE =
  'Ownership changed while this request was running. Reload and try again.';
export const MEMBER_CHANGED_MESSAGE =
  'This member changed while the request was running. Reload and try again.';

const LOCAL_CREDENTIAL_ISSUER = 'local:credential';
const CREDENTIAL_PROVIDER = 'credential';
const LIST_LIMIT = 1000;

export interface MemberRecord {
  id: string;
  email: string;
  name: string | null;
  role: WorkspaceRole;
  isOwner: boolean;
  createdAt: number;
}

export interface CreateMemberInput {
  email: string;
  name: string;
  password: string;
  role: WorkspaceRole;
}

type AuthContext = Awaited<BetterAuthInstance['$context']>;

interface StoredUser {
  id: string;
  email: string;
  name?: string | null;
  role?: string;
  isOwner?: boolean;
  createdAt: Date | string | number;
}

function toRole(value: string | undefined): WorkspaceRole {
  if (value === 'admin') {
    return 'admin';
  }
  return 'member';
}

function toMember(user: StoredUser): MemberRecord {
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? null,
    role: toRole(user.role),
    isOwner: user.isOwner === true,
    createdAt: new Date(user.createdAt).getTime(),
  };
}

type UserWriter = Pick<AuthContext['adapter'], 'updateMany' | 'deleteMany'>;

interface OwnerUpdate {
  isOwner?: boolean;
  role?: WorkspaceRole;
}

const MEMORY_ADAPTER_ID = 'memory';

function hasRealTransactions(context: AuthContext): boolean {
  if (context.adapter.id === MEMORY_ADAPTER_ID) {
    return false;
  }
  return typeof context.adapter.options?.adapterConfig.transaction === 'function';
}

function setOwnerIf(
  adapter: UserWriter,
  userId: string,
  currentlyOwner: boolean,
  update: OwnerUpdate,
): Promise<number> {
  return adapter.updateMany({
    model: 'user',
    where: [
      { field: 'id', value: userId },
      { field: 'isOwner', value: currentlyOwner },
    ],
    update,
  });
}

async function releaseOwnership(adapter: UserWriter, fromId: string): Promise<void> {
  const released = await setOwnerIf(adapter, fromId, true, { isOwner: false });
  if (released !== 1) {
    throw new ConflictException(OWNERSHIP_CHANGED_MESSAGE);
  }
}

async function moveOwnership(adapter: UserWriter, fromId: string, toId: string): Promise<void> {
  await releaseOwnership(adapter, fromId);
  const promoted = await setOwnerIf(adapter, toId, false, { role: 'admin', isOwner: true });
  if (promoted !== 1) {
    throw new ConflictException(OWNERSHIP_CHANGED_MESSAGE);
  }
}

function nonOwnerWhere(userId: string): Array<{ field: string; value: string | boolean }> {
  return [
    { field: 'id', value: userId },
    { field: 'isOwner', value: false },
  ];
}

async function deleteNonOwner(adapter: UserWriter, userId: string): Promise<void> {
  const deleted = await adapter.deleteMany({ model: 'user', where: nonOwnerWhere(userId) });
  if (deleted !== 1) {
    throw new ConflictException(MEMBER_CHANGED_MESSAGE);
  }
  await adapter.deleteMany({ model: 'session', where: [{ field: 'userId', value: userId }] });
  await adapter.deleteMany({ model: 'account', where: [{ field: 'userId', value: userId }] });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

@Injectable()
export class MemberService {
  private readonly logger = new Logger(MemberService.name);

  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  async list(): Promise<MemberRecord[]> {
    const context = await this.auth.$context;
    const users = (await context.internalAdapter.listUsers(LIST_LIMIT, 0, {
      field: 'createdAt',
      direction: 'asc',
    })) as StoredUser[];
    return users.map(toMember);
  }

  async findByEmail(email: string): Promise<MemberRecord | null> {
    const context = await this.auth.$context;
    const found = await context.internalAdapter.findUserByEmail(email.trim().toLowerCase());
    if (found === null || found === undefined) {
      return null;
    }
    return toMember(found.user as StoredUser);
  }

  async findById(id: string): Promise<MemberRecord | null> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(id);
    if (user === null || user === undefined) {
      return null;
    }
    return toMember(user as StoredUser);
  }

  async create(input: CreateMemberInput): Promise<MemberRecord> {
    const context = await this.auth.$context;
    const hashedPassword = await context.password.hash(input.password);
    const user = (await context.internalAdapter.createUser(
      {
        email: input.email.trim().toLowerCase(),
        name: input.name,
        emailVerified: false,
        role: input.role,
        isOwner: false,
      },
      { method: 'email-password' } as never,
    )) as StoredUser;
    try {
      await context.internalAdapter.linkAccount({
        userId: user.id,
        providerId: CREDENTIAL_PROVIDER,
        issuer: LOCAL_CREDENTIAL_ISSUER,
        accountId: user.id,
        password: hashedPassword,
      });
    } catch (error) {
      await this.discardUser(context, user.id);
      throw error;
    }
    return toMember(user);
  }

  private async discardUser(context: AuthContext, userId: string): Promise<void> {
    try {
      await context.internalAdapter.deleteUser(userId);
    } catch {
      return;
    }
  }

  async setRole(id: string, role: WorkspaceRole): Promise<void> {
    const context = await this.auth.$context;
    const updated = await context.adapter.updateMany({
      model: 'user',
      where: nonOwnerWhere(id),
      update: { role },
    });
    if (updated !== 1) {
      throw new ConflictException(MEMBER_CHANGED_MESSAGE);
    }
  }

  async transferOwnership(fromId: string, toId: string): Promise<void> {
    const context = await this.auth.$context;
    if (hasRealTransactions(context) === true) {
      await context.adapter.transaction(async (trx) => {
        await moveOwnership(trx, fromId, toId);
      });
      return;
    }
    await this.moveOwnershipWithCompensation(context.adapter, fromId, toId);
  }

  private async moveOwnershipWithCompensation(
    adapter: UserWriter,
    fromId: string,
    toId: string,
  ): Promise<void> {
    await releaseOwnership(adapter, fromId);
    let promoted: number;
    try {
      promoted = await setOwnerIf(adapter, toId, false, { role: 'admin', isOwner: true });
    } catch (error) {
      await this.restoreOwner(adapter, fromId, error);
      throw error;
    }
    if (promoted !== 1) {
      const conflict = new ConflictException(OWNERSHIP_CHANGED_MESSAGE);
      await this.restoreOwner(adapter, fromId, conflict);
      throw conflict;
    }
  }

  private async restoreOwner(adapter: UserWriter, fromId: string, cause: unknown): Promise<void> {
    try {
      await setOwnerIf(adapter, fromId, false, { isOwner: true });
    } catch (restoreError) {
      this.logger.error(
        `Could not restore owner ${fromId} after a failed ownership transfer. ` +
          `Transfer error: ${describeError(cause)}. Restore error: ${describeError(restoreError)}`,
      );
    }
  }

  async remove(id: string): Promise<void> {
    const context = await this.auth.$context;
    if (hasRealTransactions(context) === true) {
      await context.adapter.transaction(async (trx) => {
        await deleteNonOwner(trx, id);
      });
      return;
    }
    await deleteNonOwner(context.adapter, id);
  }

  async signIn(email: string, password: string, headers: Headers): Promise<Response> {
    return this.auth.api.signInEmail({
      body: { email, password },
      headers,
      asResponse: true,
    });
  }
}
