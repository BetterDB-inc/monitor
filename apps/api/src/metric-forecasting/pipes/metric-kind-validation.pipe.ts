import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { ALL_METRIC_KINDS, type MetricKind } from '@betterdb/shared';

const VALID_METRIC_KINDS = new Set<string>(ALL_METRIC_KINDS);

@Injectable()
export class MetricKindValidationPipe implements PipeTransform<string, MetricKind> {
  transform(value: string): MetricKind {
    if (!VALID_METRIC_KINDS.has(value)) {
      throw new BadRequestException(
        `Invalid metric kind '${value}'. Valid kinds: ${ALL_METRIC_KINDS.join(', ')}`,
      );
    }
    return value as MetricKind;
  }
}
