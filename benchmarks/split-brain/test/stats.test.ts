import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapMean, countInterval, medianInterval, pairedDifference, quantile, rateInterval, wilson } from '../src/stats';

test('wilson bound for zero of thirty', () => {
  const { low, high } = wilson(0, 30);
  assert.equal(low, 0);
  assert.ok(Math.abs(high - 0.1135) < 0.001, `high was ${high}`);
});

test('wilson interval for a mixed count matches the closed form', () => {
  const { low, high } = wilson(15, 30);
  assert.ok(Math.abs(low - 0.3315) < 0.001, `low was ${low}`);
  assert.ok(Math.abs(high - 0.6685) < 0.001, `high was ${high}`);
});

test('bootstrap is repeatable and brackets the mean', () => {
  const values = [0, 0.2, 0.4, 1, 1, 0.6, 0.8, 0, 1, 0.5];
  const first = bootstrapMean(values);
  assert.deepEqual(first, bootstrapMean(values));
  assert.ok(first.low < first.mean && first.mean < first.high);
});

test('rate interval falls back to the wilson bound when every trial agrees', () => {
  const none = rateInterval(new Array(30).fill(0));
  assert.equal(none.mean, 0);
  assert.ok(none.high > 0.11 && none.high < 0.12);
  const every = rateInterval(new Array(30).fill(1));
  assert.equal(every.high, 1);
  assert.ok(every.low > 0.88 && every.low < 0.89);
});

test('rate interval is no narrower than the wilson bound when few trials raised', () => {
  const one = rateInterval([1, ...new Array(29).fill(0)]);
  assert.ok(Math.abs(one.high - wilson(1, 30).high) < 1e-9, `high was ${one.high}`);
  assert.equal(one.low, 0);
  const allButOne = rateInterval([0, ...new Array(29).fill(1)]);
  assert.ok(Math.abs(allButOne.low - (1 - wilson(1, 30).high)) < 1e-9, `low was ${allButOne.low}`);
  assert.equal(allButOne.high, 1);
  const half = rateInterval(new Array(30).fill(0.5));
  assert.equal(half.low, 0.5);
  assert.equal(half.high, 0.5);
});

test('count interval is the wilson interval of the count', () => {
  const interval = countInterval(1, 30);
  assert.ok(Math.abs(interval.mean - 1 / 30) < 1e-12);
  assert.ok(interval.high > 0.16 && interval.high < 0.18);
});

test('median interval brackets the median and is repeatable', () => {
  const values = [5, 6, 7, 8, 9, 10, 11, 12, 13, 40];
  const interval = medianInterval(values);
  assert.deepEqual(interval, medianInterval(values));
  assert.equal(interval.mean, quantile(values, 0.5));
  assert.ok(interval.low <= interval.mean && interval.mean <= interval.high);
  assert.ok(interval.high < 40);
});

test('paired difference calls a tie only when zero is inside the interval', () => {
  const base = [1, 1, 0, 1, 0, 1, 1, 0, 1, 1];
  assert.equal(pairedDifference(base, base).identical, true);
  const noisy = pairedDifference(base, [1, 0, 1, 1, 0, 1, 0, 1, 1, 1]);
  assert.equal(noisy.tie, true);
  const worse = pairedDifference(new Array(20).fill(1), new Array(20).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)));
  assert.equal(worse.tie, false);
  assert.ok(worse.low > 0);
});

test('quantile picks from the sorted values', () => {
  assert.equal(quantile([5, 1, 3], 0.5), 3);
  assert.equal(quantile([5, 1, 3], 0.9), 5);
});
