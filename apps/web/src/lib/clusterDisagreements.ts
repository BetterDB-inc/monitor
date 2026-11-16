import type { DisagreementLine } from '@/types/anomaly';

export function isOpenDisagreement(line: DisagreementLine): boolean {
  return !line.stale || (line.confirmed && line.eventId !== null);
}
