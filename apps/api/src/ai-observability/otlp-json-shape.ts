import { HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';

const list = <T extends z.ZodType>(item: T) => z.array(item).optional();

const anyValue = z.looseObject({
  stringValue: z.string().optional(),
  boolValue: z.boolean().optional(),
  intValue: z.union([z.string(), z.number().int()]).optional(),
  doubleValue: z.number().optional(),
  arrayValue: z.unknown().optional(),
  kvlistValue: z.unknown().optional(),
  bytesValue: z.unknown().optional(),
});

const attributes = list(z.looseObject({ key: z.string(), value: anyValue.optional() }));
const resource = z.looseObject({ attributes }).optional();
const scope = z.looseObject({ name: z.string().optional(), attributes }).optional();
const dataPoints = z
  .looseObject({
    dataPoints: list(z.looseObject({ attributes, flags: z.number().int().nonnegative().optional() })),
  })
  .optional();

const metricsRequest = z.looseObject({
  resourceMetrics: list(
    z.looseObject({
      resource,
      scopeMetrics: list(
        z.looseObject({
          scope,
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
          scope,
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
