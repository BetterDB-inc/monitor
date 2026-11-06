---
name: betterdb-slow-commands
description: Use when the user asks for the slowest commands, slowlog, or COMMANDLOG in a time window such as the last hour, last day, or during an incident.
---

# Slow commands in a time window

## Overview

A named interval comes from persisted COMMANDLOG history. The live slowlog buffer has no time arguments and can be days old.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Convert the requested window to Unix milliseconds. Call `get_commandlog_history` and `get_commandlog_patterns` with `startTime`, `endTime`, and `instanceId`. With `limit` omitted, history returns the newest 100 matching rows, newest first. Patterns are built from the newest 500 input rows, then the returned `patterns` array is ordered by count, not by time. The first pattern is the most frequent in that sample, not the newest. In a busy window the slowest command can sit outside that cap. Say the answer is the newest capped sample, not a proven slowest command, unless a higher `limit` still covers the window.
3. If the text is a license sentence, report that sentence. Do not describe the window as empty.
4. If the payload has a `note` that COMMANDLOG is not available, say the instance does not support COMMANDLOG. That is not an empty window. `get_commandlog_history` returns that note as `{ entries: [], note }` instead of an array. `get_commandlog_patterns` returns the same note instead of a pattern analysis.
5. If history is an empty array and patterns have no rows, say the window has no persisted COMMANDLOG rows.
6. Only then call `get_slowlog`. Label it as the live buffer. Give each row's timestamp. Do not call that buffer "the last hour."
7. `get_slowlog_patterns` reads persisted slowlog rows, including entries that have left the live buffer, and it has no `startTime`. Use it to group that stored history. Do not call it the current buffer or the requested window.
8. `get_slowlog` durations, `get_slowlog_patterns` durations, and history rows whose `type` is `slow` or missing, are microseconds. Divide those by 1000 before saying milliseconds. History rows whose `type` is `large-request` or `large-reply` store bytes in `duration`. Report those as bytes. `get_commandlog_patterns` aggregates rows of mixed types and omits `type`, so do not convert its duration fields. Use history rows when the duration has a known unit.
9. Row `timestamp` values from `get_slowlog`, `get_commandlog`, and `get_commandlog_history` are Unix seconds. The window you passed is Unix milliseconds. Multiply a row timestamp by 1000 before comparing it to the window.

## How to report

Lead with a license sentence or a COMMANDLOG-unsupported note when that is the result. Otherwise lead with whether the window had any rows. Say history is the newest 100 unless a higher limit was passed, and that patterns are count-ordered over the newest 500 input rows. Then list command, normalized key pattern, duration, client, and timestamp. If the live buffer is older than the window, say that in the same sentence as those rows.

## Common mistakes

- Answering "slowest commands from the last hour" with `get_slowlog` alone. That tool only accepts `count`.
- Hiding an empty history window behind old buffer rows.
- Treating `get_commandlog` as the time-filtered tool. It is the live COMMANDLOG buffer and can match the slowlog buffer entry for entry.
