import type { Advisory } from '@betterdb/shared';

const SAFE_SCHEMES = ['https://'];
const CVE_ID = /^CVE-\d{4}-\d{4,}$/;

export function advisoryHref(entry: Advisory): string | null {
  const safe = entry.references.find((reference) => {
    const lowered = reference.trim().toLowerCase();

    return SAFE_SCHEMES.some((scheme) => {
      return lowered.startsWith(scheme);
    });
  });

  if (safe !== undefined) {
    return safe.trim();
  }

  if (CVE_ID.test(entry.cveId)) {
    return `https://nvd.nist.gov/vuln/detail/${entry.cveId}`;
  }

  return null;
}
