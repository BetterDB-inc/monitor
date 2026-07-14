import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { OtelIngestService, OtlpTraceRequest } from './otel-ingest.service';

/**
 * OTLP/HTTP trace ingestion. Exporters POST an ExportTraceServiceRequest here.
 * Excluded from the global `api` prefix so the path is the OTLP-standard
 * `/v1/traces` (see main.ts). JSON encoding only for now — set
 * `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` on the exporter.
 *
 * Auth: if `OTEL_INGEST_TOKEN` is set, requires `Authorization: Bearer <token>`.
 * In CLOUD_MODE the path is allowlisted past session auth, so the token is
 * mandatory there: the endpoint fails closed when it is unconfigured rather
 * than accepting anonymous spans into a tenant's store.
 * Gate: `OTEL_INGEST_ENABLED=false` disables the endpoint.
 */
@ApiTags('ai-observability')
@Controller('v1')
export class OtelIngestController {
  constructor(private readonly ingest: OtelIngestService) {}

  @Post('traces')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OTLP/HTTP (JSON) trace ingestion endpoint' })
  @ApiExcludeEndpoint()
  async ingestTraces(
    @Body() body: OtlpTraceRequest,
    @Headers('authorization') auth?: string,
  ): Promise<Record<string, never>> {
    if ((process.env.OTEL_INGEST_ENABLED ?? 'true') === 'false') {
      throw new HttpException('OTLP ingestion disabled', HttpStatus.NOT_FOUND);
    }
    const token = process.env.OTEL_INGEST_TOKEN;
    // In cloud mode /v1/traces bypasses session auth (allowlisted), so a bearer
    // token is the only credential. Fail closed when it isn't configured instead
    // of leaving the tenant's span store open to anyone who can reach the host.
    if (process.env.CLOUD_MODE && !token) {
      throw new HttpException(
        'OTLP ingestion requires OTEL_INGEST_TOKEN in cloud mode',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (token && auth !== `Bearer ${token}`) {
      throw new HttpException('Invalid ingestion token', HttpStatus.UNAUTHORIZED);
    }

    // Stamp receive time here (Date.now is unavailable inside pure helpers only).
    await this.ingest.ingest(body ?? {}, Date.now());
    // ExportTraceServiceResponse: empty body signals full success.
    return {};
  }
}
