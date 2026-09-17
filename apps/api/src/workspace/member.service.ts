import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { BrokerProvider, WorkspaceRole } from '@betterdb/shared';
import { BETTER_AUTH, type BetterAuthInstance, countUsers } from '../auth/better-auth.factory';

export const OWNERSHIP_CHANGED_MESSAGE =
  'Ownership changed while this request was running. Reload and try again.';
export const MEMBER_CHANGED_MESSAGE =
  'This member changed while the request was running. Reload and try again.';
export const ONLY_ADMINS_CAN_BECOME_OWNER_MESSAGE = 'Only admins can become the owner';

const LOCAL_CREDENTIAL_ISSUER = 'local:credential';
const CREDENTIAL_PROVIDER = 'credential';
export const LIST_LIMIT = 1000;

function brokerAccountIssuer(provider: BrokerProvider): string {
  return `local:oauth:${provider}`;
}

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

export interface CreateSocialMemberInput {
  email: string;
  name: string | null;
  image: string | null;
  role: WorkspaceRole;
  isOwner: boolean;
  provider: BrokerProvider;
  providerAccountId: string;
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

type UserWriter = Pick<AuthContext['adapter'], 'findOne' | 'updateMany' | 'deleteMany'>;

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

async function promoteOwner(adapter: UserWriter, toId: string): Promise<WorkspaceRole> {
  const target = await adapter.findOne<StoredUser>({ model: 'user', where: nonOwnerWhere(toId) });
  if (target === null) {
    throw new ConflictException(OWNERSHIP_CHANGED_MESSAGE);
  }
  if (toRole(target.role) !== 'admin') {
    throw new BadRequestException(ONLY_ADMINS_CAN_BECOME_OWNER_MESSAGE);
  }
  const promoted = await setOwnerIf(adapter, toId, false, { role: 'admin', isOwner: true });
  if (promoted !== 1) {
    throw new ConflictException(OWNERSHIP_CHANGED_MESSAGE);
  }
  return toRole(target.role);
}

async function moveOwnership(adapter: UserWriter, fromId: string, toId: string): Promise<void> {
  await promoteOwner(adapter, toId);
  await releaseOwnership(adapter, fromId);
}

function nonOwnerWhere(userId: string): Array<{ field: string; value: string | boolean }> {
  return [
    { field: 'id', value: userId },
    { field: 'isOwner', value: false },
  ];
}

async function deleteSessionsAndAccounts(adapter: UserWriter, userId: string): Promise<void> {
  await adapter.deleteMany({ model: 'session', where: [{ field: 'userId', value: userId }] });
  await adapter.deleteMany({ model: 'account', where: [{ field: 'userId', value: userId }] });
}

async function deleteNonOwner(adapter: UserWriter, userId: string): Promise<void> {
  const target = await adapter.findOne<StoredUser>({ model: 'user', where: nonOwnerWhere(userId) });
  if (target === null) {
    throw new ConflictException(MEMBER_CHANGED_MESSAGE);
  }
  await deleteSessionsAndAccounts(adapter, userId);
  const deleted = await adapter.deleteMany({ model: 'user', where: nonOwnerWhere(userId) });
  if (deleted !== 1) {
    throw new ConflictException(MEMBER_CHANGED_MESSAGE);
  }
}

function ownerWhere(userId: string): Array<{ field: string; value: string | boolean }> {
  return [
    { field: 'id', value: userId },
    { field: 'isOwner', value: true },
  ];
}

async function deleteOwner(adapter: UserWriter, userId: string): Promise<boolean> {
  const target = await adapter.findOne<StoredUser>({ model: 'user', where: ownerWhere(userId) });
  if (target === null) {
    return false;
  }
  await deleteSessionsAndAccounts(adapter, userId);
  const deleted = await adapter.deleteMany({ model: 'user', where: ownerWhere(userId) });
  return deleted === 1;
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
  private membershipQueue: Promise<unknown> = Promise.resolve();

  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  private serializeMembershipChange<T>(change: () => Promise<T>): Promise<T> {
    const run = this.membershipQueue.then(change);
    this.membershipQueue = run.catch(() => {
      return undefined;
    });
    return run;
  }

  async list(): Promise<MemberRecord[]> {
    const context = await this.auth.$context;
    const users = (await context.internalAdapter.listUsers(LIST_LIMIT, 0, {
      field: 'createdAt',
      direction: 'asc',
    })) as StoredUser[];
    if (users.length === LIST_LIMIT) {
      this.logger.warn(`Member list truncated at ${LIST_LIMIT} members`);
    }
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

  async count(): Promise<number> {
    return countUsers(this.auth);
  }

  async createSocial(input: CreateSocialMemberInput): Promise<MemberRecord> {
    const context = await this.auth.$context;
    const email = input.email.trim().toLowerCase();
    const user = (await context.internalAdapter.createUser(
      {
        email,
        name: input.name ?? email,
        image: input.image,
        emailVerified: true,
        role: input.role,
        isOwner: input.isOwner,
      },
      { method: 'social' } as never,
    )) as StoredUser;
    try {
      await context.internalAdapter.linkAccount({
        userId: user.id,
        providerId: input.provider,
        issuer: brokerAccountIssuer(input.provider),
        accountId: input.providerAccountId,
      });
    } catch (error) {
      await this.discardUser(context, user.id);
      throw error;
    }
    return toMember(user);
  }

  async ensureProviderLink(
    userId: string,
    provider: BrokerProvider,
    providerAccountId: string,
  ): Promise<void> {
    const context = await this.auth.$context;
    const accounts = await context.internalAdapter.findAccountByUserId(userId);
    const linked = accounts.some((account) => {
      return account.providerId === provider;
    });
    if (linked === true) {
      return;
    }
    await context.internalAdapter.linkAccount({
      userId,
      providerId: provider,
      issuer: brokerAccountIssuer(provider),
      accountId: providerAccountId,
    });
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
    await this.serializeMembershipChange(() => {
      return this.moveOwnershipWithCompensation(context.adapter, fromId, toId);
    });
  }

  private async moveOwnershipWithCompensation(
    adapter: UserWriter,
    fromId: string,
    toId: string,
  ): Promise<void> {
    const previousRole = await promoteOwner(adapter, toId);
    try {
      await releaseOwnership(adapter, fromId);
    } catch (error) {
      await this.demoteTarget(adapter, toId, previousRole, error);
      throw error;
    }
  }

  private async demoteTarget(
    adapter: UserWriter,
    toId: string,
    previousRole: WorkspaceRole,
    cause: unknown,
  ): Promise<void> {
    try {
      await setOwnerIf(adapter, toId, true, { isOwner: false, role: previousRole });
    } catch (demoteError) {
      this.logger.error(
        `Could not demote ${toId} after a failed ownership transfer. ` +
          `Transfer error: ${describeError(cause)}. Demote error: ${describeError(demoteError)}`,
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
    await this.serializeMembershipChange(() => {
      return deleteNonOwner(context.adapter, id);
    });
  }

  async discardBootstrapOwner(id: string): Promise<void> {
    const context = await this.auth.$context;
    const discarded = await this.deleteIfSoleOwner(context, id);
    if (discarded === false) {
      this.logger.warn(
        `Kept user ${id} after a failed first sign-in: it is not the sole owner of the workspace`,
      );
    }
  }

  private async deleteIfSoleOwner(context: AuthContext, id: string): Promise<boolean> {
    if ((await context.adapter.count({ model: 'user' })) !== 1) {
      return false;
    }
    if (hasRealTransactions(context) === true) {
      return context.adapter.transaction((trx) => {
        return deleteOwner(trx, id);
      });
    }
    return deleteOwner(context.adapter, id);
  }

  async signIn(email: string, password: string, headers: Headers): Promise<Response> {
    return this.auth.api.signInEmail({
      body: { email, password },
      headers,
      asResponse: true,
    });
  }

  startSession(userId: string, headers: Headers): Promise<Response> {
    return this.auth.api.brokerSession({ body: { userId }, headers, asResponse: true });
  }
}
