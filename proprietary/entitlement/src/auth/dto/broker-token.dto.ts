import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { BROKER_PROVIDERS, BrokerProvider } from '@betterdb/shared';

export class BrokerTokenDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  avatarUrl?: string;

  @IsIn([...BROKER_PROVIDERS])
  provider: BrokerProvider;

  @IsString()
  @Length(1, 200)
  providerId: string;

  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  aud: string;

  @Matches(/^[A-Za-z0-9_-]{43}$/)
  state: string;
}
