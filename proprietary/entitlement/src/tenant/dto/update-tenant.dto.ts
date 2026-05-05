import { IsString, IsEmail, IsOptional, IsBoolean, MinLength, MaxLength } from 'class-validator';

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  imageTag?: string;

  @IsOptional()
  @IsBoolean()
  isDemo?: boolean;
}
