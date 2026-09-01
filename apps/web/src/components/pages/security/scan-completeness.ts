import type { CveScanResult, ScannedNode } from '@betterdb/shared';

export type ScanCaveatId =
  | 'not-scanned'
  | 'missing-sources'
  | 'unversioned'
  | 'undecoded-modules'
  | 'modules-unknown'
  | 'partial';

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
      if (loaded.version === null) {
        names.add(loaded.name);
      }
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
    text: `${count} ${noun} could not be matched to a version — unknown, not safe.`,
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

  if (result.partial === true && caveats.length === 0) {
    caveats.push({
      id: 'partial',
      text: 'The server marked this scan incomplete; part of this instance was never checked.',
    });
  }

  return { complete: caveats.length === 0, caveats, unversionedCount };
}
