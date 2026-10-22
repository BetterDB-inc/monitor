import Valkey, { Cluster } from 'iovalkey';
import type { KeyCountComparison, MigrationAnalysisResult } from '@betterdb/shared';

/**
 * DBSIZE that covers the whole dataset. On a Cluster client a bare DBSIZE goes
 * to one random node, so sum it over every master instead.
 */
export async function countKeys(client: Valkey): Promise<number> {
  // createTargetClient() casts Cluster to Valkey, so narrow from unknown.
  const maybeCluster: unknown = client;
  if (maybeCluster instanceof Cluster) {
    const masters = maybeCluster.nodes('master');
    if (masters.length === 0) throw new Error('No cluster masters available to count keys');
    const counts = await Promise.all(masters.map((node) => node.dbsize()));
    return counts.reduce((sum, count) => sum + count, 0);
  }
  return client.dbsize();
}

/**
 * Compare key counts between source and target using DBSIZE (summed over all
 * masters for cluster clients). Optionally enrich with per-type breakdown from
 * Phase 1 analysis.
 */
export async function compareKeyCounts(
  sourceClient: Valkey,
  targetClient: Valkey,
  analysisResult?: Partial<MigrationAnalysisResult>,
): Promise<KeyCountComparison> {
  const [sourceKeys, targetKeys] = await Promise.all([
    countKeys(sourceClient),
    countKeys(targetClient),
  ]);

  const discrepancy = targetKeys - sourceKeys;
  const discrepancyPercent = sourceKeys === 0
    ? (targetKeys > 0 ? 100 : 0)
    : Math.abs(discrepancy / sourceKeys) * 100;

  const result: KeyCountComparison = {
    sourceKeys,
    targetKeys,
    discrepancy,
    discrepancyPercent: Math.round(discrepancyPercent * 100) / 100,
  };

  // Flag when source is empty but target has stale keys
  if (sourceKeys === 0 && targetKeys > 0) {
    result.warning =
      'Source has 0 keys but target has data. Target may contain stale keys from a previous migration or other writes.';
  }

  // Risk #4: DBSIZE counts all databases, SCAN only covers db0 by default.
  // If source is standalone but target is cluster, key count may be misleading.
  if (analysisResult?.isCluster === false && analysisResult?.targetIsCluster === true) {
    result.warning =
      'Source uses multiple databases; target is cluster-mode (db0 only). Key count may not be directly comparable.';
  }

  // Build per-type breakdown if Phase 1 analysis data is available
  if (analysisResult?.dataTypeBreakdown && sourceKeys > 0) {
    const ratio = targetKeys / sourceKeys;
    const breakdown = analysisResult.dataTypeBreakdown;
    const types: Array<keyof typeof breakdown> = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'other'];

    result.typeBreakdown = types
      .filter(t => breakdown[t].count > 0)
      .map(t => ({
        type: t,
        sourceEstimate: breakdown[t].count,
        targetEstimate: Math.round(breakdown[t].count * ratio),
      }));
  }

  return result;
}
