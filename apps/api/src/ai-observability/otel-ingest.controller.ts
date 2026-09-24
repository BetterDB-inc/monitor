import {
  Controller,
  Post,
  Body,
  Headers,
  Res,
  HttpCode,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import { OtelIngestService, OtlpTraceRequest } from './otel-ingest.service';
import { decodeOtlpTraceProtobuf } from './otlp-protobuf';
import { assertOtlpIngestAuthorized } from './otel-ingest-auth';
import { assertOtlpTraceShape } from './otlp-json-shape';

/**
 * OTLP/HTTP trace ingestion. Exporters POST an ExportTraceServiceRequest here.
 * Excluded from the global `api` prefix so the path is the OTLP-standard
 * `/v1/traces` (see main.ts). Accepts both encodings:
 *   - `application/json`      (set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`)
 *   - `application/x-protobuf` (the OTel SDK default `http/protobuf`)
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
  @ApiOperation({ summary: 'OTLP/HTTP trace ingestion endpoint (JSON or protobuf)' })
  @ApiExcludeEndpoint()
  async ingestTraces(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: OtlpTraceRequest | Buffer,
    @Headers('content-type') contentType?: string,
    @Headers('authorization') auth?: string,
  ): Promise<Buffer | Record<string, never>> {
    assertOtlpIngestAuthorized(auth);

    const isProtobuf = (contentType ?? '').includes('application/x-protobuf');
    let request: OtlpTraceRequest;
    if (isProtobuf) {
      if (!Buffer.isBuffer(body)) {
        throw new HttpException('Expected a protobuf body', HttpStatus.BAD_REQUEST);
      }
      try {
        request = decodeOtlpTraceProtobuf(body);
      } catch (err) {
        throw new HttpException(
          `Failed to decode OTLP protobuf: ${err instanceof Error ? err.message : 'unknown'}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      request = (body as OtlpTraceRequest) ?? {};
      assertOtlpTraceShape(request);
    }

    // Stamp receive time here (Date.now is unavailable inside pure helpers only).
    await this.ingest.ingest(request, Date.now());

    // OTLP/HTTP requires the response to match the request encoding. An empty
    // ExportTraceServiceResponse signals full success in both: `{}` for JSON,
    // zero bytes for protobuf.
    if (isProtobuf) {
      reply.header('content-type', 'application/x-protobuf');
      return Buffer.alloc(0);
    }
    return {};
  }
}
