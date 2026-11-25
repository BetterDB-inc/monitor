import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOTAL_SLOTS, evenShards, ownerOf, slotStatsAt } from '../src/model';
import { b2Model } from '../src/scenarios';
import { simulate } from '../src/simulate';

test('even shards cover every slot once', () => {
  const shards = evenShards(6);
  const covered = shards.reduce((total, { slots: [start, end] }) => total + end - start + 1, 0);
  assert.equal(covered, TOTAL_SLOTS);
  assert.equal(shards[0].slots[0], 0);
  assert.equal(shards[5].slots[1], TOTAL_SLOTS - 1);
});

test('counters grow with the modelled rate', () => {
  const model = b2Model();
  const owner = ownerOf(model, 9189);
  const at = (seconds: number) =>
    slotStatsAt(model, seconds).find((node) => node.nodeId === owner.nodeId)!.stats[9189];
  assert.equal(at(10).cpu_usec! - at(0).cpu_usec!, 9_300_000);
});

test('the tracker measures the modelled shard load', () => {
  const model = b2Model();
  const { sample } = simulate(model, 10);
  const owner = ownerOf(model, 9189);
  const shard = sample.shards.find((each) => each.nodeId === owner.nodeId)!;
  const expected = 930_000 + (shard.slotCount - 1) * model.baseCpuUsecPerSlot;
  assert.ok(
    Math.abs(shard.cpuUsecPerSecond - expected) / expected < 0.01,
    `${shard.cpuUsecPerSecond} vs ${expected}`,
  );
  assert.equal(sample.settling, false);
});
