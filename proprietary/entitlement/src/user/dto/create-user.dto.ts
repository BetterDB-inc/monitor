import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AuthProvider, UserRole } from '../../generated/prisma/client.js';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsEnum(AuthProvider)
  provider: AuthProvider;

  @IsNotEmpty()
  @IsString()
  providerId: string;

  @IsNotEmpty()
  @IsString()
  tenantId: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
