---
name: betterdb-slow-commands
description: Use when the user asks for the slowest commands, slowlog, or COMMANDLOG in a time window such as the last hour, last day, or during an incident.
---

# Slow commands in a time window

## Overview

A named interval comes from persisted COMMANDLOG history. The live slowlog buffer has no time arguments and can be days old.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Convert the requested window to Unix milliseconds. Call `get_commandlog_history` and `get_commandlog_patterns` with `startTime`, `endTime`, and `instanceId`.
3. If both are empty, say the window has no persisted COMMANDLOG rows.
4. Only then call `get_slowlog`. Label it as the live buffer. Give each row's timestamp. Do not call that buffer "the last hour."
5. `get_slowlog_patterns` also has no `startTime`. Use it to group the buffer, and say it is the whole buffer, not the requested window.
6. Durations on these tools are microseconds. Divide by 1000 before saying milliseconds.

## How to report

Lead with whether the window had any rows. Then list command, normalized key pattern, duration, client, and timestamp. If the buffer is older than the window, say that in the same sentence as the rows.

## Common mistakes

- Answering "slowest commands from the last hour" with `get_slowlog` alone. That tool only accepts `count`.
- Hiding an empty history window behind old buffer rows.
- Treating `get_commandlog` as the time-filtered tool. It is the live COMMANDLOG buffer and can match the slowlog buffer entry for entry.
