import * as fs from 'fs';
import * as path from 'path';
import { parseLmcacheMetrics } from '../prometheus-text';

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/lmcache-metrics.txt'), 'utf8');

describe('parseLmcacheMetrics', () => {
  it('keeps lmcache counters, strips _total and skips the rest', () => {
    const samples = parseLmcacheMetrics(fixture);
    expect(samples.map((s) => [s.metric, s.value])).toEqual([
      ['num_requested_tokens', 1000],
      ['num_hit_tokens', 700],
      ['remote_ping_errors', 2],
    ]);
  });

  it('reads labels including escapes', () => {
    const [first, , last] = parseLmcacheMetrics(fixture);
    expect(first.labels).toEqual({ model_name: 'Qwen/Qwen2.5-0.5B-Instruct', role: 'worker', served_model_name: 'qwen', worker_id: '0' });
    expect(last.labels.model_name).toBe('a"b\\c\nd');
    expect(last.labels.worker_id).toBe('1');
  });

  it('accepts series without labels and ignores malformed lines', () => {
    expect(parseLmcacheMetrics('lmcache:num_lookup_hits_total 5\nlmcache:broken{model_name="x" 1\n')).toEqual([
      { metric: 'num_lookup_hits', labels: {}, value: 5 },
    ]);
  });
});
