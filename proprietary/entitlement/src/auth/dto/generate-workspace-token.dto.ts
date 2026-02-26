import { IsEmail } from 'class-validator';

export class GenerateWorkspaceTokenDto {
  @IsEmail()
  email: string;
}
