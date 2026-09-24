import { createHash, timingSafeEqual } from 'crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { isCloudMode } from '../common/utils/cloud-mode';

export function assertOtlpIngestAuthorized(auth?: string): void {
  if ((process.env.OTEL_INGEST_ENABLED ?? 'true') === 'false') {
    throw new HttpException('OTLP ingestion disabled', HttpStatus.NOT_FOUND);
  }
  const token = process.env.OTEL_INGEST_TOKEN;
  if (isCloudMode() && !token) {
    throw new HttpException(
      'OTLP ingestion requires OTEL_INGEST_TOKEN in cloud mode',
      HttpStatus.UNAUTHORIZED,
    );
  }
  if (token && !matchesBearer(auth, token)) {
    throw new HttpException('Invalid ingestion token', HttpStatus.UNAUTHORIZED);
  }
}

function matchesBearer(auth: string | undefined, token: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(auth ?? ''), digest(`Bearer ${token}`));
}
