import { Body, Controller, Headers, HttpCode, HttpException, HttpStatus, Post, Res } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { assertOtlpIngestAuthorized } from '../ai-observability/otel-ingest-auth';
import { assertOtlpMetricsShape } from '../ai-observability/otlp-json-shape';
import { OtelMetricsIngestService, toPartialSuccess } from './otel-metrics-ingest.service';
import { decodeOtlpMetricsProtobuf, encodeOtlpMetricsResponse } from './otlp-metrics-protobuf';
import type { OtlpMetricsRequest } from './otlp-metrics-types';

type JsonResponse = Record<string, never> | { partialSuccess: { rejectedDataPoints: string; errorMessage: string } };

@Controller('v1/external')
export class OtelMetricsIngestController {
  constructor(private readonly ingestService: OtelMetricsIngestService) {}

  @Post('metrics')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  ingestMetrics(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: OtlpMetricsRequest | Buffer,
    @Headers('content-type') contentType?: string,
    @Headers('authorization') auth?: string,
  ): Buffer | JsonResponse {
    assertOtlpIngestAuthorized(auth);

    const isProtobuf = (contentType ?? '').includes('application/x-protobuf');
    let request: OtlpMetricsRequest;
    if (isProtobuf) {
      if (!Buffer.isBuffer(body)) {
        throw new HttpException('Expected a protobuf body', HttpStatus.BAD_REQUEST);
      }
      try {
        request = decodeOtlpMetricsProtobuf(body);
      } catch (err) {
        throw new HttpException(
          `Failed to decode OTLP protobuf: ${err instanceof Error ? err.message : 'unknown'}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      request = (body as OtlpMetricsRequest) ?? {};
      assertOtlpMetricsShape(request);
    }

    const partial = toPartialSuccess(this.ingestService.ingest(request));

    if (isProtobuf) {
      reply.header('content-type', 'application/x-protobuf');
      return encodeOtlpMetricsResponse(partial);
    }
    if (!partial) return {};
    return {
      partialSuccess: {
        rejectedDataPoints: String(partial.rejectedDataPoints),
        errorMessage: partial.errorMessage,
      },
    };
  }
}
