import { Inject, Injectable } from '@nestjs/common';
import type { WorkspaceRole } from '@betterdb/shared';
import { BETTER_AUTH, type BetterAuthInstance } from '../auth/better-auth.factory';

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

@Injectable()
export class MemberService {
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
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: CREDENTIAL_PROVIDER,
      issuer: LOCAL_CREDENTIAL_ISSUER,
      accountId: user.id,
      password: hashedPassword,
    });
    return toMember(user);
  }

  async setRole(id: string, role: WorkspaceRole): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.updateUser(id, { role });
  }

  async transferOwnership(fromId: string, toId: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.updateUser(toId, { role: 'admin', isOwner: true });
    await context.internalAdapter.updateUser(fromId, { isOwner: false });
  }

  async remove(id: string): Promise<void> {
    const context = await this.auth.$context;
    await context.internalAdapter.deleteUser(id);
  }

  async signIn(email: string, password: string, headers: Headers): Promise<Response> {
    return this.auth.api.signInEmail({
      body: { email, password },
      headers,
      asResponse: true,
    });
  }
}
