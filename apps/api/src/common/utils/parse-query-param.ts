import { BadRequestException } from '@nestjs/common';

export function parseOptionalInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) throw new BadRequestException(`${name} must be a valid integer`);
  return parsed;
}
