import { CustomDecorator, SetMetadata } from '@nestjs/common';
import type { WorkspaceRole } from '@betterdb/shared';

export const ROLES_KEY = 'workspace:roles';
export const OWNER_ONLY_KEY = 'workspace:owner-only';
export const ALLOW_MEMBERS_KEY = 'workspace:allow-members';

export function Roles(...roles: WorkspaceRole[]): CustomDecorator<string> {
  return SetMetadata(ROLES_KEY, roles);
}

export function OwnerOnly(): CustomDecorator<string> {
  return SetMetadata(OWNER_ONLY_KEY, true);
}

export function AllowMembers(): CustomDecorator<string> {
  return SetMetadata(ALLOW_MEMBERS_KEY, true);
}
