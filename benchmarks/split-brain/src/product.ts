import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type { ClusterNode } from '../../../apps/api/src/common/types/metrics.types';
export { MetricsParser } from '../../../apps/api/src/database/parsers/metrics.parser';
export {
  detectDuplicatePrimaries,
} from '../../../proprietary/anomaly-detection/duplicate-primary-detector';
export {
  type DivergenceGroup,
  type DivergenceKind,
  type OpenDivergence,
  type TrackedDisagreement,
  confirmedDisagreements,
  groupDivergences,
  migrationTouchesSlots,
  settleOpenDivergences,
} from '../../../proprietary/anomaly-detection/topology-divergence';
export {
  type DivergenceRoundResult,
  TOPOLOGY_DIVERGENCE_DEFAULTS,
  TOPOLOGY_DIVERGENCE_MAX_MIGRATION_CHECKS,
  TOPOLOGY_DIVERGENCE_MEMBERSHIP_MIN_AGE_MS,
  TopologyDivergenceMonitor,
} from '../../../proprietary/anomaly-detection/topology-divergence-monitor';
export {
  divergenceSeverity,
  outranksSeverity,
} from '../../../proprietary/anomaly-detection/topology-divergence-report';

const repoRoot = join(__dirname, '..', '..', '..');
const pinFile = join(__dirname, '..', 'product-pin.json');

export const PINNED_FILES = [
  'proprietary/anomaly-detection/topology-divergence.ts',
  'proprietary/anomaly-detection/topology-divergence-monitor.ts',
  'proprietary/anomaly-detection/topology-observers.ts',
  'proprietary/anomaly-detection/topology-divergence-report.ts',
  'proprietary/anomaly-detection/duplicate-primary-detector.ts',
  'proprietary/anomaly-detection/types.ts',
  'apps/api/src/database/parsers/metrics.parser.ts',
];

export interface ProductPin {
  commit: string;
  files: Record<string, string>;
}

function currentHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of PINNED_FILES) {
    hashes[file] = createHash('sha256').update(readFileSync(join(repoRoot, file))).digest('hex');
  }
  return hashes;
}

export function writePin(commit: string): ProductPin {
  const pin = { commit, files: currentHashes() };
  writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

export function assertPinned(): ProductPin {
  const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as ProductPin;
  const now = currentHashes();
  const changed = PINNED_FILES.filter((file) => pin.files[file] !== now[file]);
  if (changed.length > 0) {
    throw new Error(
      `detector files differ from pinned commit ${pin.commit}: ${changed.join(', ')}. ` +
        'Re-run the cross-check tests, then `bench pin <commit>`.',
    );
  }
  return pin;
}
