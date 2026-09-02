import { describe, expect, it } from 'vitest';
import { finding, node, unversionedAdvisory } from '../../../pages/__fixtures__/cve';
import { groupFindings } from './drift-groups';

function ids(entries: { advisory: { cveId: string } }[]): string[] {
  return entries.map((entry) => {
    return entry.advisory.cveId;
  });
}

describe('groupFindings', () => {
  it('puts a CVE present on every node in shared', () => {
    const groups = groupFindings([
      node('1', '8.0.9', [finding('CVE-A')]),
      node('2', '8.0.9', [finding('CVE-A')]),
    ]);

    expect(ids(groups.get('1')?.shared ?? [])).toEqual(['CVE-A']);
    expect(groups.get('1')?.unique).toEqual([]);
  });

  it('puts a CVE present on one node only in unique', () => {
    const groups = groupFindings([
      node('1', '8.0.9', [finding('CVE-A')]),
      node('2', '8.0.4', [finding('CVE-A'), finding('CVE-B')]),
    ]);

    expect(ids(groups.get('2')?.unique ?? [])).toEqual(['CVE-B']);
    expect(ids(groups.get('2')?.shared ?? [])).toEqual(['CVE-A']);
    expect(groups.get('1')?.unique).toEqual([]);
  });

  it('keeps unversioned advisories in their own group', () => {
    const groups = groupFindings([
      node('1', '8.0.9', [finding('CVE-A')], [unversionedAdvisory('CVE-U')]),
    ]);

    expect(
      groups.get('1')?.unversioned.map((entry) => {
        return entry.cveId;
      }),
    ).toEqual(['CVE-U']);
    expect(ids(groups.get('1')?.unique ?? [])).toEqual([]);
  });

  it('makes the badge equal unique plus shared, excluding unversioned', () => {
    const groups = groupFindings([
      node('1', '8.0.9', [finding('CVE-A')], [unversionedAdvisory('CVE-U')]),
      node(
        '2',
        '8.0.4',
        [finding('CVE-A'), finding('CVE-B'), finding('CVE-C')],
        [unversionedAdvisory('CVE-U')],
      ),
    ]);
    const second = groups.get('2');

    expect(second?.badge).toBe(3);
    expect(second?.badge).toBe((second?.unique.length ?? 0) + (second?.shared.length ?? 0));
  });

  it('treats a single-node set as all-shared, not all-unique', () => {
    const groups = groupFindings([node('1', '8.0.9', [finding('CVE-A')])]);

    expect(ids(groups.get('1')?.shared ?? [])).toEqual(['CVE-A']);
  });
});
