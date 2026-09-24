import { IsIn } from 'class-validator';
import type { WorkspaceRole } from '@betterdb/shared';

export class UpdateMemberRoleDto {
  @IsIn(['admin', 'member'])
  role: WorkspaceRole;
}
