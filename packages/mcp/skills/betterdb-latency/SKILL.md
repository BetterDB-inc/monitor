---
name: betterdb-latency
description: Use when the user asks what is slow, about latency spikes, fork time, command latency, or whether the database got slower.
---

# Latency

## Overview

Name the latency event, or say that none is recorded. An empty list is an answer, but it does not rule out stalls.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Call `get_latency` with `instanceId`.
3. If the list is empty, say no latency events are recorded. `get_latency` reads LATENCY LATEST, which stays empty while `latency-monitor-threshold` is 0, the server default. No MCP tool reads that setting. Say the latency monitor may be off, so the empty list cannot rule out stalls. Do not call `get_latency_history`.
4. If the list names an event, call `get_latency_history` with that `eventName`. Event names match `^[a-zA-Z0-9_.-]+$`. Typical names are `command` and `fork`.
5. Call `get_latency_regressions` with the requested `startTime` when the user says the database got slower. A license sentence means regression detection is not available on this tier. A `Latency regression detection is unavailable` sentence means this monitor build lacks it. Either one ends this step (see `betterdb-triage`). Say that, and keep the `get_latency` result.
6. For "which command was slow," switch to `betterdb-slow-commands`. Latency events are not the slowlog.

## Optional context from get_info

`get_info` section `stats` has `latest_fork_usec` and `instantaneous_eventloop_duration_usec`. Use them only as context next to an empty latency list. They are not a latency-doctor report. Doctor and histogram routes are not MCP tools.

## Common mistakes

- Treating `[]` from `get_latency` as a failed call.
- Treating `[]` from `get_latency` as proof that nothing stalled. The latency monitor is off by default.
- Calling `get_latency_history` with a guessed event name.
- Answering a "last hour" command question with latency events.
