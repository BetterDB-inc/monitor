import { HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';

const list = <T extends z.ZodType>(item: T) => z.array(item).optional();

const attributes = list(z.looseObject({}));
const resource = z.looseObject({ attributes }).optional();
const dataPoints = z.looseObject({ dataPoints: list(z.looseObject({ attributes })) }).optional();

const metricsRequest = z.looseObject({
  resourceMetrics: list(
    z.looseObject({
      resource,
      scopeMetrics: list(
        z.looseObject({
          metrics: list(
            z.looseObject({
              name: z.string().optional(),
              gauge: dataPoints,
              sum: dataPoints,
              histogram: dataPoints,
              exponentialHistogram: dataPoints,
              summary: dataPoints,
            }),
          ),
        }),
      ),
    }),
  ),
});

const traceRequest = z.looseObject({
  resourceSpans: list(
    z.looseObject({
      resource,
      scopeSpans: list(
        z.looseObject({
          scope: z.looseObject({ name: z.string().optional() }).optional(),
          spans: list(z.looseObject({ attributes })),
        }),
      ),
    }),
  ),
});

function assertShape(schema: z.ZodType, body: unknown, kind: string): void {
  const result = schema.safeParse(body);
  if (result.success) return;
  const issue = result.error.issues[0];
  const path = issue.path.join('.') || '(root)';
  throw new HttpException(
    `Malformed OTLP ${kind} request at ${path}: ${issue.message}`,
    HttpStatus.BAD_REQUEST,
  );
}

export function assertOtlpMetricsShape(body: unknown): void {
  assertShape(metricsRequest, body, 'metrics');
}

export function assertOtlpTraceShape(body: unknown): void {
  assertShape(traceRequest, body, 'trace');
}
