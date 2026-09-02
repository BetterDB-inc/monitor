import type { CveDatasetStatus, CveScanResult, ScannedNode } from '@betterdb/shared';
import { moduleProductOf } from '@betterdb/shared';

export type ScanCaveatId =
  | 'not-scanned'
  | 'missing-sources'
  | 'unversioned'
  | 'undecoded-modules'
  | 'modules-unknown'
  | 'topology-unknown'
  | 'partial'
  | 'dataset-empty'
  | 'dataset-degraded';

export interface ScanCaveat {
  id: ScanCaveatId;
  text: string;
}

export interface ScanCompleteness {
  complete: boolean;
  caveats: ScanCaveat[];
  unversionedCount: number;
}

function unversionedTotal(nodes: ScannedNode[]): number {
  return nodes.reduce((total, entry) => {
    return total + entry.unversioned.length;
  }, 0);
}

function undecodedModuleNames(nodes: ScannedNode[]): string[] {
  const names = new Set<string>();

  for (const entry of nodes) {
    for (const loaded of entry.modules) {
      if (loaded.version !== null) {
        continue;
      }

      if (moduleProductOf(entry.product, loaded.name) === undefined) {
        continue;
      }

      names.add(loaded.name);
    }
  }

  return [...names];
}

function unlistedModuleAddresses(nodes: ScannedNode[]): string[] {
  return nodes
    .filter((entry) => {
      return entry.modulesUnknown === true;
    })
    .map((entry) => {
      return entry.address;
    });
}

function notScannedCaveat(result: CveScanResult): ScanCaveat {
  const detail = result.notScanned
    .map((entry) => {
      return `${entry.address} (${entry.reason})`;
    })
    .join(', ');
  const total = result.notScanned.length + result.nodes.length;

  return {
    id: 'not-scanned',
    text: `${result.notScanned.length} of ${total} nodes could not be scanned, so anything only they run was never checked: ${detail}.`,
  };
}

function missingSourcesCaveat(result: CveScanResult): ScanCaveat {
  const names = result.missingSources
    .map((source) => {
      return source.toUpperCase();
    })
    .join(', ');
  const carries = result.missingSources.length === 1 ? 'that feed carries' : 'those feeds carry';

  return {
    id: 'missing-sources',
    text: `This scan ran without ${names}, so advisories only ${carries} were never matched.`,
  };
}

function unversionedCaveat(count: number): ScanCaveat {
  const noun = count === 1 ? 'advisory' : 'advisories';

  return {
    id: 'unversioned',
    text: `${count} ${noun} could not be matched to a version - unknown, not safe.`,
  };
}

function undecodedModulesCaveat(names: string[]): ScanCaveat {
  return {
    id: 'undecoded-modules',
    text: `${names.join(', ')} reported no readable version, so advisories for ${names.length === 1 ? 'it' : 'them'} were never version-matched.`,
  };
}

function modulesUnknownCaveat(addresses: string[]): ScanCaveat {
  const noun = addresses.length === 1 ? 'node' : 'nodes';

  return {
    id: 'modules-unknown',
    text: `The modules loaded on ${addresses.length} ${noun} could not be enumerated (${addresses.join(', ')}), so module advisories there are unknown, not absent.`,
  };
}

export function datasetCaveats(dataset: CveDatasetStatus | undefined): ScanCaveat[] {
  if (dataset === undefined) {
    return [
      {
        id: 'dataset-empty',
        text: 'Advisory source health is unknown, so nothing here can be called an all-clear.',
      },
    ];
  }

  if (dataset.sources.length === 0 || dataset.advisoryCount === 0) {
    return [
      {
        id: 'dataset-empty',
        text: 'No advisories have been fetched yet, so this instance was never matched against anything.',
      },
    ];
  }

  const unhealthy = dataset.sources.filter((source) => {
    return source.state !== 'ok';
  });

  if (unhealthy.length === 0) {
    return [];
  }

  const names = unhealthy
    .map((source) => {
      return source.source.toUpperCase();
    })
    .join(', ');

  return [
    {
      id: 'dataset-degraded',
      text: `${names} did not answer on the last refresh, so the corpus behind this scan is incomplete.`,
    },
  ];
}

export function scanCompleteness(result: CveScanResult): ScanCompleteness {
  const caveats: ScanCaveat[] = [];
  const unversionedCount = unversionedTotal(result.nodes);

  if (result.notScanned.length > 0) {
    caveats.push(notScannedCaveat(result));
  }

  if (result.missingSources.length > 0) {
    caveats.push(missingSourcesCaveat(result));
  }

  if (unversionedCount > 0) {
    caveats.push(unversionedCaveat(unversionedCount));
  }

  const undecoded = undecodedModuleNames(result.nodes);

  if (undecoded.length > 0) {
    caveats.push(undecodedModulesCaveat(undecoded));
  }

  const unlisted = unlistedModuleAddresses(result.nodes);

  if (unlisted.length > 0) {
    caveats.push(modulesUnknownCaveat(unlisted));
  }

  if (result.topologyUnknown === true) {
    caveats.push({
      id: 'topology-unknown',
      text: 'This instance did not report whether it belongs to a cluster, so it was scanned as a single node - any other node in that cluster was never checked.',
    });
  }

  if (result.partial === true && caveats.length === 0) {
    caveats.push({
      id: 'partial',
      text: 'The server marked this scan incomplete; part of this instance was never checked.',
    });
  }

  return { complete: caveats.length === 0, caveats, unversionedCount };
}
