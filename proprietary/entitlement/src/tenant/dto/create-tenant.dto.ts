import { IsString, IsEmail, IsOptional, Matches, MinLength, MaxLength } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: 'subdomain must be lowercase alphanumeric with hyphens, starting and ending with alphanumeric',
  })
  subdomain: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsOptional()
  imageTag?: string;
}
