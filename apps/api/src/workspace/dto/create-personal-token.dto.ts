import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const MAX_TOKEN_NAME_LENGTH = 100;

export class CreatePersonalTokenDto {
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value === 'string') {
      return value.trim();
    }
    return value;
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_TOKEN_NAME_LENGTH)
  name: string;

  @IsOptional()
  @IsIn(['mcp', 'agent'])
  type?: 'mcp' | 'agent';
}
