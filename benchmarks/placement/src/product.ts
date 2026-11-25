import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type {
  NodeSlotStats,
  ShardLoadSample,
  SlotLoadRate,
} from '../../../apps/api/src/cluster/shard-load';
export { ShardLoadTracker } from '../../../apps/api/src/cluster/shard-load';
export { isManagedProviderBuild } from '../../../apps/api/src/monitor/provider-detector';
export { judgeHotShards } from '../../../proprietary/anomaly-detection/hot-shard-detector';
export {
  type RebalanceShard,
  type RebalanceVerdict,
  planRebalances,
  shardServerFromInfo,
} from '../../../proprietary/anomaly-detection/rebalance-planner';
export { placementBalance } from '../../../proprietary/placement/placement-balance';
export {
  type PlacementPrimaryFacts,
  type PlacementSupportFacts,
  judgePlacementSupport,
  managedPlacementProvider,
  migrateSlotsListed,
} from '../../../proprietary/placement/placement-support';

const repoRoot = join(__dirname, '..', '..', '..');
const pinFile = join(__dirname, '..', 'product-pin.json');

export const PINNED_FILES = [
  'apps/api/src/cluster/shard-load.ts',
  'apps/api/src/monitor/provider-detector.ts',
  'proprietary/anomaly-detection/hot-shard-detector.ts',
  'proprietary/anomaly-detection/rebalance-planner.ts',
  'proprietary/anomaly-detection/anomaly.service.ts',
  'proprietary/placement/placement-balance.ts',
  'proprietary/placement/placement-support.ts',
  'proprietary/placement/placement.service.ts',
];

export interface ProductPin {
  commit: string;
  files: Record<string, string>;
}

function currentHashes(): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const file of PINNED_FILES) {
    hashes[file] = createHash('sha256')
      .update(readFileSync(join(repoRoot, file)))
      .digest('hex');
  }
  return hashes;
}

export function writePin(commit: string): ProductPin {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  const resolved = git(['rev-parse', '--verify', `${commit}^{commit}`]);
  const differing = git(['diff', '--name-only', resolved, '--', ...PINNED_FILES]);
  if (differing) {
    throw new Error(
      `the working tree differs from ${resolved.slice(0, 8)} in: ${differing.split('\n').join(', ')}`,
    );
  }
  const pin = { commit: resolved.slice(0, 8), files: currentHashes() };
  writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

export function checkPin(): ProductPin {
  const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as ProductPin;
  const hashes = currentHashes();
  const changed = PINNED_FILES.filter((file) => pin.files[file] !== hashes[file]);
  if (changed.length > 0) {
    throw new Error(
      `product files changed since ${pin.commit}: ${changed.join(', ')}. ` +
        'Check src/glue.ts against them, then run `pnpm bench pin <commit>`.',
    );
  }
  return pin;
}
