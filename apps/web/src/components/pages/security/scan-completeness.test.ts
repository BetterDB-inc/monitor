import { describe, expect, it } from 'vitest';
import { node, scanResult, unversionedAdvisory } from '../../../pages/__fixtures__/cve';
import { scanCompleteness } from './scan-completeness';

function idsOf(result: ReturnType<typeof scanCompleteness>): string[] {
  return result.caveats.map((entry) => {
    return entry.id;
  });
}

describe('scanCompleteness', () => {
  it('calls a clean scan complete', () => {
    const result = scanCompleteness(scanResult({ nodes: [node('1', '8.0.10', [])] }));

    expect(result.complete).toBe(true);
    expect(result.caveats).toEqual([]);
  });

  it('refuses to call a partial scan complete even when nothing else is wrong', () => {
    const result = scanCompleteness(
      scanResult({ nodes: [node('1', '8.0.10', [])], partial: true }),
    );

    expect(result.complete).toBe(false);
    expect(idsOf(result)).toEqual(['partial']);
  });

  it('names the module whose version could not be read instead of an unattributed partial', () => {
    const result = scanCompleteness(
      scanResult({
        nodes: [
          node('1', '8.0.10', [], [], {
            modules: [
              { name: 'search', version: null },
              { name: 'json', version: '1.0.0' },
            ],
          }),
        ],
        partial: true,
      }),
    );

    expect(idsOf(result)).toEqual(['undecoded-modules']);
    expect(result.caveats[0].text).toContain('search');
    expect(result.caveats[0].text).not.toContain('json');
  });

  it('refuses to call a scan complete when the modules on a node could not be enumerated', () => {
    const result = scanCompleteness(
      scanResult({
        nodes: [node('1', '8.0.10', [], [], { modules: [], modulesUnknown: true })],
        partial: false,
      }),
    );

    expect(result.complete).toBe(false);
    expect(idsOf(result)).toEqual(['modules-unknown']);
    expect(result.caveats[0].text).toContain('10.0.0.1:6379');
    expect(result.caveats[0].text).toMatch(/unknown, not absent/i);
  });

  it('leaves a node whose modules were enumerated as empty free of the caveat', () => {
    const result = scanCompleteness(
      scanResult({ nodes: [node('1', '8.0.10', [], [], { modules: [] })], partial: false }),
    );

    expect(result.complete).toBe(true);
    expect(idsOf(result)).toEqual([]);
  });

  it('names every node whose modules could not be enumerated, not only the first', () => {
    const result = scanCompleteness(
      scanResult({
        nodes: [
          node('1', '8.0.10', [], [], { modulesUnknown: true }),
          node('2', '8.0.10', [], [], { modulesUnknown: true }),
        ],
      }),
    );

    expect(result.caveats[0].text).toContain('10.0.0.1:6379');
    expect(result.caveats[0].text).toContain('10.0.0.2:6379');
    expect(result.caveats[0].text).toContain('2 nodes');
  });

  it('treats unversioned advisories as unknown, not safe', () => {
    const result = scanCompleteness(
      scanResult({
        nodes: [node('1', '8.0.10', [], [unversionedAdvisory('CVE-A')])],
        partial: false,
      }),
    );

    expect(result.complete).toBe(false);
    expect(result.unversionedCount).toBe(1);
    expect(idsOf(result)).toEqual(['unversioned']);
  });

  it('names every unreachable node and its reason', () => {
    const result = scanCompleteness(
      scanResult({
        nodes: [node('1', '8.0.10', [])],
        notScanned: [{ nodeId: '2', address: '10.0.0.2:6379', reason: 'auth failed' }],
        partial: true,
      }),
    );

    expect(idsOf(result)).toEqual(['not-scanned']);
    expect(result.caveats[0].text).toContain('1 of 2 nodes');
    expect(result.caveats[0].text).toContain('10.0.0.2:6379 (auth failed)');
  });

  it('names the sources the scan ran without', () => {
    const result = scanCompleteness(
      scanResult({
        nodes: [node('1', '8.0.10', [])],
        missingSources: ['nvd', 'kev'],
        partial: true,
      }),
    );

    expect(idsOf(result)).toEqual(['missing-sources']);
    expect(result.caveats[0].text).toContain('NVD, KEV');
  });

  it('reports every reason at once rather than only the first', () => {
    const result = scanCompleteness(
      scanResult({
        nodes: [node('1', '8.0.10', [], [unversionedAdvisory('CVE-A')])],
        notScanned: [{ nodeId: '2', address: '10.0.0.2:6379', reason: 'unreachable' }],
        missingSources: ['nvd'],
        partial: true,
      }),
    );

    expect(idsOf(result)).toEqual(['not-scanned', 'missing-sources', 'unversioned']);
  });
});
