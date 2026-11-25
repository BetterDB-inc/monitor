# Placement benchmark

Checks the slot placement work against the scenarios of the placement autopilot
design. This is the first of its three layers: a deterministic simulator with
no Docker. Each phase adds the scenarios it needs.

## How it works

- `src/model.ts` is a per-slot load model: a base CPU and network rate for every
  slot, plus single hot slots. It turns the model into cumulative
  `CLUSTER SLOT-STATS` counters at any simulated second.
- `src/simulate.ts` feeds those counters every 15 simulated seconds into the
  real `ShardLoadTracker`, then runs the real hot shard judgement, rebalance
  planner and placement balance on the last sample.
- `src/scenarios.ts` holds the scenarios and checks their expectations.

The product modules are imported by path, not copied. Two small pieces cannot
be imported without their Nest services, so `src/glue.ts` restates them: the
list of shards the anomaly service hands the planner, and the facts the
placement service reads before it judges support. `product-pin.json` holds the
hashes of the imported files and of those two services; the run and the tests
refuse to start when any of them differs.

## Scenarios

| # | Variant | Expectation |
| --- | --- | --- |
| B2 | Single hot key: one slot carries 85% of its shard and more than the node CPU limit | The shard is hot and over the trigger, no plan in any mode, and the `key_level` explanation names the slot |
| B8 | Self-hosted control | Supported; every mode available |
| B8 | ElastiCache host name; the provider override | `provider_managed`; Approve and Auto refused, Recommend available |
| B8 | Self-hosted EC2 host with Amazon Linux in the OS field | Supported; the OS field is never a managed signal |
| B8 | `NOPERM` on a slot move; a renamed command; Valkey 8.1 | `acl`, `command_unavailable`, `server_version`; Approve and Auto refused |
| B8 | `METRICS_SLOT_STATS_TOP_N=0` | `slot_stats_off`; only Observe |
| B8 | `STORAGE_TYPE=memory` | `memory_storage`; Approve and Auto refused, Recommend clean |

Not covered yet: B2's hash-tag variant comes with the hash tag advisor, and the
LFU variant with the key name needs the hot key reads. Nothing in phase 1 sends
a write command, so B8's count of write commands waits for the fake cluster
layer, which arrives with Approve.

## Running it

Needs Node 22 and pnpm 9. The package is standalone; install inside this
directory.

```bash
pnpm install
pnpm bench
pnpm test
pnpm typecheck
```

`pnpm bench` prints every check and exits with 1 when a scenario fails.

After a change to a pinned file, check `src/glue.ts` against it, commit, and
pin that commit:

```bash
pnpm bench pin <commit>
```
