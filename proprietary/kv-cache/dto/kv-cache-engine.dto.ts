import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, Length, Matches, MaxLength, ValidateIf } from 'class-validator';

const URL_OPTIONS = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

export class CreateKvCacheEngineDto {
  @IsString() @Length(1, 100) name!: string;
  @IsIn(['scrape', 'otlp']) source!: 'scrape' | 'otlp';
  @ValidateIf((o) => o.source === 'scrape') @IsUrl(URL_OPTIONS) scrapeUrl?: string;
  @IsOptional() @IsString() @MaxLength(4096) scrapeAuthHeader?: string;
  @IsOptional() @Matches(/^[A-Za-z0-9._-]{1,64}$/) otlpEngineId?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateKvCacheEngineDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsUrl(URL_OPTIONS) scrapeUrl?: string;
  @IsOptional() @ValidateIf((o) => o.scrapeAuthHeader !== null) @IsString() @MaxLength(4096) scrapeAuthHeader?: string | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
