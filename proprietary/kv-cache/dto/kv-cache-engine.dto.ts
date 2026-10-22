import { IsBoolean, IsIn, IsString, IsUrl, Length, Matches, MaxLength, ValidateBy, ValidateIf } from 'class-validator';

const URL_OPTIONS = { require_tld: false, require_protocol: true, allow_underscores: true, protocols: ['http', 'https'] };

export const OTLP_ENGINE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const provided = (_: object, value: unknown) => value !== undefined;

function hasNoCredentials(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return !url.username && !url.password;
  } catch {
    return true;
  }
}

const NoUrlCredentials = () =>
  ValidateBy({
    name: 'noUrlCredentials',
    validator: {
      validate: hasNoCredentials,
      defaultMessage: () => 'scrapeUrl must not contain credentials; send them in scrapeAuthHeader instead',
    },
  });

export class CreateKvCacheEngineDto {
  @IsString() @Length(1, 100) name!: string;
  @IsIn(['scrape', 'otlp']) source!: 'scrape' | 'otlp';
  @ValidateIf((o) => o.source === 'scrape') @IsUrl(URL_OPTIONS) @NoUrlCredentials() scrapeUrl?: string;
  @ValidateIf(provided) @IsString() @MaxLength(4096) scrapeAuthHeader?: string;
  @ValidateIf(provided) @Matches(OTLP_ENGINE_ID_PATTERN) otlpEngineId?: string;
  @ValidateIf(provided) @IsBoolean() enabled?: boolean;
}

export class UpdateKvCacheEngineDto {
  @ValidateIf(provided) @IsString() @Length(1, 100) name?: string;
  @ValidateIf(provided) @IsUrl(URL_OPTIONS) @NoUrlCredentials() scrapeUrl?: string;
  @ValidateIf((_, value) => value !== undefined && value !== null) @IsString() @MaxLength(4096) scrapeAuthHeader?: string | null;
  @ValidateIf(provided) @IsBoolean() enabled?: boolean;
}
