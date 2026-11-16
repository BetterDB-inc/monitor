import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostWatch, countFreePorts } from '../src/host';

test('free ports count distinct local ports inside the range only', () => {
  assert.equal(countFreePorts([80, 49152, 49152, 49153, 65535, 70000], [49152, 65535]), 16384 - 3);
});

test('a breach names every limit that was crossed', () => {
  const watch = new HostWatch({ maxLoad: 10, minFreePorts: 8000 });
  assert.equal(watch.breach(10, 8000), null);
  assert.match(watch.breach(10.5, 9000) ?? '', /host load 10\.5 is over 10$/);
  assert.match(watch.breach(11, 100) ?? '', /load 11\.0 is over 10 and 100 free local ports is under 8000/);
});

test('a window reports the first, the worst and the last sample', async () => {
  const watch = new HostWatch({ maxLoad: 1000, minFreePorts: 0 });
  const first = await watch.sample();
  const last = await watch.sample();
  const window = watch.since(first.at);
  assert.equal(window.load.start, first.load);
  assert.equal(window.load.end, last.load);
  assert.equal(window.freePorts.min, Math.min(first.freePorts, last.freePorts));
  assert.ok(first.freePorts > 0 && first.freePorts <= 65536);
  assert.throws(() => watch.since(Date.now() + 60_000), /no host samples/);
});
