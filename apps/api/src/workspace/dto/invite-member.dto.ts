import { IsEmail, IsIn } from 'class-validator';
import type { WorkspaceRole } from '@betterdb/shared';

export class InviteMemberDto {
  @IsEmail()
  email: string;

  @IsIn(['admin', 'member'])
  role: WorkspaceRole;
}
