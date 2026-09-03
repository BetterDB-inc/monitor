import { IsString, MaxLength, MinLength } from 'class-validator';

export class AcceptInviteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
