---
name: betterdb-slow-commands
description: Use when the user asks for the slowest commands, slowlog, or COMMANDLOG in a time window such as the last hour, last day, or during an incident.
---

# Slow commands in a time window

## Overview

A named interval comes from persisted COMMANDLOG history. The live slowlog buffer has no time arguments and can be days old.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Convert the requested window to Unix milliseconds. Call `get_commandlog_history` and `get_commandlog_patterns` with `startTime`, `endTime`, and `instanceId`. With `limit` omitted, history returns the newest 100 matching rows and patterns are built from the newest 500. Both are ordered by time, not by duration. In a busy window the slowest command can sit outside that cap. Say the answer is the newest capped rows, not a proven slowest command, unless a higher `limit` still covers the window.
3. If the text is a license sentence, report that sentence. Do not describe the window as empty.
4. If both results are empty, say the window has no persisted COMMANDLOG rows.
5. Only then call `get_slowlog`. Label it as the live buffer. Give each row's timestamp. Do not call that buffer "the last hour."
6. `get_slowlog_patterns` reads persisted slowlog rows, including entries that have left the live buffer, and it has no `startTime`. Use it to group that stored history. Do not call it the current buffer or the requested window.
7. `get_slowlog` durations, and history rows whose `type` is `slow` or missing, are microseconds. Divide those by 1000 before saying milliseconds. History rows whose `type` is `large-request` or `large-reply` store bytes in `duration`. Report those as bytes. Pattern totals drop `type`, so do not convert a pattern duration to milliseconds when the rows mix slow and large entries.

## How to report

Lead with a license sentence when that is the result. Otherwise lead with whether the window had any rows, and say when the answer is capped at the newest 100 or 500. Then list command, normalized key pattern, duration, client, and timestamp. If the live buffer is older than the window, say that in the same sentence as those rows.

## Common mistakes

- Answering "slowest commands from the last hour" with `get_slowlog` alone. That tool only accepts `count`.
- Hiding an empty history window behind old buffer rows.
- Treating `get_commandlog` as the time-filtered tool. It is the live COMMANDLOG buffer and can match the slowlog buffer entry for entry.
