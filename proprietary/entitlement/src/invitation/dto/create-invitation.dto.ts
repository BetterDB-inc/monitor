import { IsEmail, IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateInvitationDto {
  @IsNotEmpty()
  @IsString()
  tenantId: string;

  @IsEmail()
  email: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsNotEmpty()
  @IsString()
  invitedBy: string;
}
