import { describe, expect, it } from 'vitest';
import { advisory } from '../../../pages/__fixtures__/cve';
import { advisoryHref } from './advisory-link';

describe('advisoryHref', () => {
  it('uses the first published reference', () => {
    const href = advisoryHref(
      advisory('CVE-2026-63639', {
        references: ['https://github.com/advisories/GHSA-x', 'https://nvd.nist.gov/other'],
      }),
    );

    expect(href).toBe('https://github.com/advisories/GHSA-x');
  });

  it('refuses a javascript: reference and falls through to the CVE record', () => {
    const href = advisoryHref(advisory('CVE-2026-63639', { references: ['javascript:alert(1)'] }));

    expect(href).toBe('https://nvd.nist.gov/vuln/detail/CVE-2026-63639');
  });

  it('refuses a data: reference', () => {
    const href = advisoryHref(
      advisory('GHSA-abcd-efgh-ijkl', { references: ['data:text/html,x'] }),
    );

    expect(href).toBeNull();
  });

  it('has no link for a non-CVE id with no references', () => {
    expect(advisoryHref(advisory('GHSA-abcd-efgh-ijkl', { references: [] }))).toBeNull();
  });

  it('links a bare CVE id to its NVD record', () => {
    expect(advisoryHref(advisory('CVE-2025-49112', { references: [] }))).toBe(
      'https://nvd.nist.gov/vuln/detail/CVE-2025-49112',
    );
  });
});
