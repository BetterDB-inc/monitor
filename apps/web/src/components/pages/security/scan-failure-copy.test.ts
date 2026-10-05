import { describe, expect, it } from 'vitest';
import { scanFailureCopy } from './scan-failure-copy';

const SUMMARY = 'No node in this connection could be scanned.';
const NODES = [{ address: 'cache.internal:6379', reason: 'no version' }];

describe('scanFailureCopy', () => {
  it('keeps the live probe wording for a live connection', () => {
    const copy = scanFailureCopy(SUMMARY, NODES);

    expect(copy.guidance).toContain('INFO and MODULE LIST');
    expect(copy.detail).toContain('never answered');
  });

  it('talks about pushed data instead of a live probe for an external connection', () => {
    const copy = scanFailureCopy(SUMMARY, NODES, true);

    expect(copy.guidance).not.toContain('MODULE LIST');
    expect(copy.guidance).toContain('collector');
    expect(copy.detail).toContain('pushed metrics');
    expect(copy.detail).not.toContain('never answered');
  });
});
