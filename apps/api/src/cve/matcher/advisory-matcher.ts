import type { Advisory, CveFinding, CveProduct, CveSeverity, LoadedModule } from '@betterdb/shared';
import { MODULE_PRODUCTS } from '../cve.constants';
import { matchRanges } from './version-range';

export interface MatchInput {
  product: CveProduct;
  engineVersion: string;
  modules: LoadedModule[];
}

export interface MatchOutput {
  findings: CveFinding[];
  unversioned: Advisory[];
  severityCounts: Record<CveSeverity, number>;
}

const EMPTY_COUNTS: Record<CveSeverity, number> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
};

function moduleFor(input: MatchInput, product: CveProduct): LoadedModule | undefined {
  const table = MODULE_PRODUCTS[input.product];
  if (!table) {
    return undefined;
  }

  return input.modules.find((loaded) => {
    return table[loaded.name.toLowerCase()] === product;
  });
}

export function rankFindings(findings: CveFinding[]): CveFinding[] {
  return [...findings].sort((a, b) => {
    if (a.advisory.knownExploited !== b.advisory.knownExploited) {
      return a.advisory.knownExploited ? -1 : 1;
    }

    const epssDiff = (b.advisory.epssScore ?? -1) - (a.advisory.epssScore ?? -1);
    if (epssDiff !== 0) {
      return epssDiff;
    }

    const cvssDiff = (b.advisory.cvssScore ?? -1) - (a.advisory.cvssScore ?? -1);
    if (cvssDiff !== 0) {
      return cvssDiff;
    }

    return a.advisory.cveId.localeCompare(b.advisory.cveId);
  });
}

export function matchAdvisories(input: MatchInput, advisories: Advisory[]): MatchOutput {
  const findings: CveFinding[] = [];
  const unversioned: Advisory[] = [];
  const severityCounts: Record<CveSeverity, number> = { ...EMPTY_COUNTS };

  for (const advisory of advisories) {
    const isEngine = advisory.product === input.product;
    const loadedModule = isEngine ? undefined : moduleFor(input, advisory.product);

    if (!isEngine && !loadedModule) {
      continue;
    }

    if (advisory.affected.length === 0) {
      unversioned.push(advisory);
      continue;
    }

    const version = isEngine ? input.engineVersion : (loadedModule as LoadedModule).version;
    const match = matchRanges(version, advisory.affected);

    if (!match.vulnerable) {
      continue;
    }

    findings.push({
      advisory,
      matchedOn: isEngine ? 'engine' : 'module',
      matchedVersion: version,
      ...(loadedModule ? { moduleName: loadedModule.name } : {}),
      ...(match.fixedIn ? { fixedIn: match.fixedIn } : {}),
    });
    severityCounts[advisory.severity] += 1;
  }

  return { findings: rankFindings(findings), unversioned, severityCounts };
}
