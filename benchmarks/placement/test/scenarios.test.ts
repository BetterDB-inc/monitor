import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPin } from '../src/product';
import { B2_HOT_SLOT, B8_CASES, b2Model, runAll, runB8Case } from '../src/scenarios';
import { simulate } from '../src/simulate';

test('the product files match the pin', () => {
  assert.doesNotThrow(() => checkPin());
});

test('every scenario passes', () => {
  const failed = runAll()
    .filter((scenario) => !scenario.pass)
    .map(
      (scenario) =>
        `${scenario.id} ${scenario.variant}: ${scenario.checks
          .filter((each) => !each.pass)
          .map((each) => each.name)
          .join('; ')}`,
    );
  assert.deepEqual(failed, []);
});

test('a hot slot under the node CPU limit is not explained as key level', () => {
  const { verdicts } = simulate(b2Model(400_000), 10);
  assert.equal(verdicts.length, 1);
  assert.notEqual(verdicts[0].kind === 'no_plan' ? verdicts[0].reason : 'plan', 'key_level');
});

test('a wrong expectation fails the scenario', () => {
  const control = B8_CASES[0];
  const scenario = runB8Case({ ...control, reasons: ['acl'] });
  assert.equal(scenario.pass, false);
});

test('the provider override is put back after a case', () => {
  const before = process.env.MONITOR_PROVIDER_OVERRIDE;
  runB8Case(B8_CASES.find((entry) => entry.providerOverride !== undefined)!);
  assert.equal(process.env.MONITOR_PROVIDER_OVERRIDE, before);
});

test('the hot slot is the one the model loads', () => {
  const { verdicts } = simulate(b2Model(), 10);
  const verdict = verdicts[0];
  assert.equal(verdict.kind, 'no_plan');
  assert.deepEqual(verdict.kind === 'no_plan' ? verdict.pinnedSlots.map((slot) => slot.slot) : [], [
    B2_HOT_SLOT,
  ]);
});
