import { parseArgs } from '../../scripts/cluster-load/run';

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

describe('cluster load test, flags', () => {
  let printed = '';

  beforeEach(() => {
    printed = '';
    jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Exit(code as number | undefined);
    });
    const remember = (chunk: unknown): boolean => {
      printed += String(chunk);
      return true;
    };
    jest.spyOn(process.stderr, 'write').mockImplementation(remember);
    jest.spyOn(process.stdout, 'write').mockImplementation(remember);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const rejected = (argv: string[]): string => {
    expect(() => parseArgs(argv)).toThrow(new Exit(1));
    return printed;
  };

  it('takes the directory given to --out', () => {
    expect(parseArgs(['--out', 'results']).out).toBe('results');
  });

  it('prints the usage text for --out without a directory', () => {
    const output = rejected(['--nodes', '4', '--out']);
    expect(output).toContain('--out needs a directory');
    expect(output).toContain('Usage: pnpm load:cluster');
  });

  it('prints the usage text for --out with an empty directory', () => {
    expect(rejected(['--out', '', '--nodes', '4'])).toContain('--out needs a directory');
  });

  it('prints the usage text when --out is followed by another flag', () => {
    expect(rejected(['--out', '--force'])).toContain('--out needs a directory');
  });

  it('takes one hung node next to a failover in a cluster of four', () => {
    const options = parseArgs(['--nodes', '4', '--replicas', '1', '--hang', '1', '--failover']);
    expect(options).toMatchObject({ nodes: [4], hang: 1, failover: true });
  });

  it('rejects more hung nodes than a failover leaves', () => {
    const output = rejected(['--nodes', '4', '--replicas', '1', '--hang', '2', '--failover']);
    expect(output).toContain('--hang 2 with --failover');
    expect(output).toContain('at most 1');
  });

  it('still rejects hanging every node', () => {
    expect(rejected(['--nodes', '4', '--hang', '4'])).toContain('--hang 4');
  });

  it('leaves the call sites out unless asked', () => {
    expect(parseArgs([]).callSites).toBe(false);
    expect(parseArgs(['--call-sites']).callSites).toBe(true);
  });
});
