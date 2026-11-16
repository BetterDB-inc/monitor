import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shownInViews } from '../src/collect';
import type { Sample, Tick } from '../src/recorder';
import { PreparedTrace, seedOnly } from '../src/replay';
import { assertOneConfiguration } from '../src/report';
import type { TrialOutput } from '../src/collect';
import type { Trace } from '../src/trace';

const line = (id: string, flags: string, slots: string) => `${id} 10.0.0.1:6379@16379 ${flags} - 0 0 1 connected ${slots}`;

function view(self: string, flagsOfB = 'master', slotsOfA = '0-8191'): Sample {
  const flags = (id: string, base: string) => (id === self ? `myself,${base}` : base);
  return {
    ok: true,
    lat: 1,
    nodes: [line('a', flags('a', 'master'), slotsOfA), line('b', flags('b', flagsOfB), '8192-16383')].join('\n'),
    info: { state: 'ok', slotsOk: 16384, slotsPfail: 0, slotsFail: 0, knownNodes: 2, size: 2, currentEpoch: 1 },
    migrations: [],
  };
}

const silent: Sample = { ok: false, lat: 2000, err: 'timeout' };

function trace(ticks: Array<Record<string, Sample>>): Trace {
  return { meta: {} as Trace['meta'], ticks: ticks.map((nodes, index): Tick => ({ t: index * 1000, late: 0, nodes })) };
}

test('agreeing views show nothing, whoever is marked as myself', () => {
  const shown = shownInViews(trace([{ a: view('a'), b: view('b') }]), ['a', 'b'], 0, 10_000);
  assert.deepEqual(shown, { ticks: 1, flagged: 0, unanswered: 0, split: 0, longestSplitTicks: 0, splitRounds: 0 });
});

test('a failure flag held by one node is a flag and a disagreement', () => {
  const split = { a: view('a', 'master,fail?'), b: view('b') };
  const calm = { a: view('a'), b: view('b') };
  const shown = shownInViews(trace([calm, split, split, calm, split]), ['a', 'b'], 0, 10_000);
  assert.equal(shown.flagged, 3);
  assert.equal(shown.split, 3);
  assert.equal(shown.longestSplitTicks, 2);
  assert.equal(shown.splitRounds, 1);
});

test('a silent node is counted without making a disagreement', () => {
  const shown = shownInViews(trace([{ a: view('a'), b: silent }]), ['a', 'b'], 0, 10_000);
  assert.equal(shown.unanswered, 1);
  assert.equal(shown.split, 0);
});

test('migration markers in a node\'s own line are not a disagreement', () => {
  const moving = { a: view('a', 'master', '0-8191 [100->-b]'), b: view('b') };
  assert.equal(shownInViews(trace([moving]), ['a', 'b'], 0, 10_000).split, 0);
});

test('only ticks inside the window are counted', () => {
  const split = { a: view('a', 'master,fail'), b: view('b') };
  assert.equal(shownInViews(trace([split, split, split]), ['a', 'b'], 1000, 1000).ticks, 1);
});

test('rounds in a row are counted five seconds apart, not by unbroken samples', () => {
  const split = { a: view('a', 'master,fail?'), b: view('b') };
  const calm = { a: view('a'), b: view('b') };
  const everyFifth = Array.from({ length: 16 }, (_, index) => (index % 5 === 2 ? split : calm));
  const spaced = shownInViews(trace(everyFifth), ['a', 'b'], 0, 60_000);
  assert.equal(spaced.longestSplitTicks, 1);
  assert.equal(spaced.splitRounds, 3);
  const unbroken = Array.from({ length: 16 }, (_, index) => (index >= 3 && index <= 7 ? split : calm));
  const short = shownInViews(trace(unbroken), ['a', 'b'], 0, 60_000);
  assert.equal(short.longestSplitTicks, 5);
  assert.equal(short.splitRounds, 1);
  const longer = Array.from({ length: 16 }, (_, index) => (index >= 3 && index <= 8 ? split : calm));
  assert.equal(shownInViews(trace(longer), ['a', 'b'], 0, 60_000).splitRounds, 2);
});

test('a seed that misses its round runs the round at its next answer', () => {
  const split = { a: view('a', 'master,fail?'), b: view('b') };
  const calm = { a: view('a'), b: view('b') };
  const mute = { a: silent, b: view('b') };
  const around = (fifth: Record<string, Sample>) => [split, calm, calm, calm, calm, fifth, split, calm, calm, calm, calm, split];
  assert.equal(shownInViews(trace(around(mute)), ['a', 'b'], 0, 60_000).splitRounds, 3);
  assert.equal(shownInViews(trace(around(calm)), ['a', 'b'], 0, 60_000).splitRounds, 2);
});

test('silence is the longest run of missed samples, not their total', () => {
  const up = { a: view('a'), b: view('b') };
  const down = { a: silent, b: view('b') };
  const recorded = trace([down, up, down, down, up, down]);
  recorded.meta = { nodes: [{ name: 'a', id: 'a', ip: '', zone: 'z', role: 'primary' }] } as Trace['meta'];
  assert.equal(seedOnly(new PreparedTrace(recorded), 'a', 0, 60_000).longestSilentTicks, 2);
  assert.equal(seedOnly(new PreparedTrace(recorded), 'a', 3_000, 60_000).longestSilentTicks, 1);
});

test('a report refuses trials recorded with different setups', () => {
  const trial = (nodes: number, nodeTimeoutMs: number) => ({ nodes, nodeTimeoutMs, valkey: '9.1.3' }) as TrialOutput;
  assert.doesNotThrow(() => assertOneConfiguration([trial(6, 5_000), trial(6, 5_000)]));
  assert.throws(() => assertOneConfiguration([trial(6, 5_000), trial(12, 5_000)]), /mix configurations/);
  assert.throws(() => assertOneConfiguration([trial(6, 5_000), trial(6, 15_000)]), /mix configurations/);
});
