---
title: User Control
nav_order: 2.5
---

# User Control

On a self-hosted install, BetterDB Monitor can require sign-in and manage who
can do what: an owner, admins, and read-only members, plus invitations, an
activity log, personal MCP tokens, and optional Google/GitHub sign-in.

This page is the task-oriented guide. For the full list of the environment
variables mentioned here, see the
[Configuration Reference](configuration#security).

## Contents

- [First run: claiming the workspace](#first-run-claiming-the-workspace)
- [Roles and what each can do](#roles-and-what-each-can-do)
- [Inviting people](#inviting-people)
- [Managing members](#managing-members)
- [Signing in with Google or GitHub](#signing-in-with-google-or-github)
- [Personal MCP tokens](#personal-mcp-tokens)
- [The activity log](#the-activity-log)
- [Running behind HTTPS](#running-behind-https)
- [Turning user control off](#turning-user-control-off)

## First run: claiming the workspace

When user control is on (the default), the first time you open the dashboard
you see a **register** screen instead of the app. The first account to register
becomes the **workspace owner** and holds the `admin` role. Public registration
then closes — everyone else joins by invitation.

Existing installs that upgrade with the default setting see the same register
screen on first load; whoever registers first claims ownership, so do this step
yourself right after upgrading.

Set a real `AUTH_SECRET` (at least 32 characters) before going to production,
especially when running more than one replica — otherwise sessions are
invalidated whenever the process that generated the secret restarts. See the
[Configuration Reference](configuration#security) for
details.

## Roles and what each can do

| Capability | Owner | Admin | Member |
| --- | :---: | :---: | :---: |
| View dashboards, metrics, monitor tail, browser CLI (read commands) | ✓ | ✓ | ✓ |
| Add / edit / delete connections and any other mutation | ✓ | ✓ | — |
| Invite people, change roles, remove members | ✓ | ✓ | — |
| Read the activity log | ✓ | ✓ | — |
| Read server configuration (`GET /metrics/config`) | ✓ | ✓ | — |
| Run write / admin CLI commands (`CONFIG`, `ACL`, …) | ✓ | ✓ | — |
| Transfer ownership | ✓ | — | — |

**Members are read-only.** Every `POST`, `PUT`, `PATCH`, and `DELETE` answers
`403` for a member, except signing in/out and a small set of read-only `POST`
endpoints (vector similarity search, profiling, and full-text search, plus the
monitor session preflight check — these run a query but do not mutate data).

Two reads are admin-only because the server configuration they return can carry
credentials such as `requirepass` or `masterauth`: `GET /metrics/config` and
`GET /metrics/config/:parameter`.

**CLI and monitor sockets require a signed-in session** — an unauthenticated
socket is rejected before the WebSocket handshake completes. A member's CLI
session is restricted to read-only commands regardless of `BETTERDB_UNSAFE_CLI`:
`CONFIG`, `ACL`, `DEBUG`, and `CLIENT` are refused because they expose
configuration and credentials, and `SLOWLOG RESET`, `COMMANDLOG RESET`, and
`LATENCY RESET` are refused because they clear diagnostic state. Members can
read monitor capture sessions, including the live tail; captured values are
redacted only when `MONITOR_REDACT_VALUES=true`.

## Inviting people

The monitor sends no email — you invite people by generating a link and sharing
it however you like.

1. Open **Settings → Team** and choose **Invite**.
2. Enter the person's email and pick a role (`member` or `admin`).
3. Copy the one-time link that appears. It is
   `<AUTH_PUBLIC_URL>/invite/<token>` (or the current origin when
   `AUTH_PUBLIC_URL` is unset), and it is **shown only once** — the server keeps
   only a hash of it.
4. Send the link. It **expires after 7 days**.

When the invitee opens the link they see the invited email and role, set a name
and password, and are signed in with the role you chose.

You can revoke a pending invitation from the Team page. Re-inviting an email
whose earlier invitation was revoked, accepted, or expired issues a fresh link.

## Managing members

From **Settings → Team**, the owner can:

- **Change another member's role** between `member` and `admin`.
- **Remove a member**, which immediately ends their sessions.
- **Transfer ownership** to another member. The previous owner stays an admin.

Members can see the team's names and roles, but not each other's email
addresses.

> Role and membership changes take effect within about 30 seconds, because
> sessions are cached in a signed cookie for that window rather than
> re-checked on every request.

## Signing in with Google or GitHub

Self-hosted installs can show **Sign in with Google** and **Sign in with
GitHub** buttons on the login, register, and accept-invite screens. Sign-in is
handled by a page hosted at `AUTH_BROKER_URL` (defaults to
`https://betterdb.com`); your install only needs outbound browser access to that
origin, and nothing else leaves your network.

Accounts are matched **by email**. Google or GitHub sign-in works only for an
email that already belongs to a member, has a pending invitation, or arrives
while the workspace is empty (in which case that person becomes the owner).

Notes:

- **In production** (`NODE_ENV=production`), this requires `AUTH_PUBLIC_URL` to
  be set. Without it the buttons report as unavailable and the sign-in routes
  answer `404`, because the callback address sent to the broker must come from a
  configured origin, not from the request's `Host` header.
- The key that verifies these sign-ins ships embedded with the release that
  turns the feature on. Until then, set `AUTH_BROKER_PUBLIC_KEY` to enable it.
- To disable it entirely (for example on an air-gapped install), set
  `AUTH_BROKER_DISABLED=true`. The buttons are hidden and the routes answer
  `404`.

## Personal MCP tokens

To let an MCP client act as you, create a token under **Settings → MCP Tokens**
and pass it to the client as `BETTERDB_TOKEN`:

```bash
npx @betterdb/mcp
```

On self-hosted installs a token is **optional**: read tools work without one.
With a token, every call acts as you, and any changes it makes are recorded
under your name in the [activity log](#the-activity-log). You can revoke a token
at any time from the same screen.

See [Install → MCP](install/llm) and [Packages](packages) for the full tool
list.

## The activity log

Admins can review who did what from **Settings → Team → Activity**, or from
`GET /api/workspace/activity` (query params `actor`, `action`, `from`, `to`,
`cursor`, `limit` ≤ 100).

What gets recorded:

- Every `POST`, `PUT`, `PATCH`, and `DELETE` by a signed-in user, with the user,
  source IP, connection (`X-Connection-Id`), route, response status, and — where
  the route has one — the affected object (a connection id, invitation id,
  member id, or bulk-delete job id).
- Sign-ins, sign-outs, and invitation acceptances (`auth.login` /
  `auth.logout`).
- Every browser CLI command (`cli.command`) with the command name and argument
  count. Argument **values** are kept only for read commands — never for `AUTH`,
  `HELLO`, `CONFIG`, `ACL`, or `MIGRATE` — and at most the first 16 arguments of
  128 characters each.

Requests the server refuses with `401` or `403` are not recorded. Rows are kept
for `ACTIVITY_RETENTION_DAYS` (default `90`); older rows are pruned once a day
and at startup.

## Running behind HTTPS

Set `AUTH_PUBLIC_URL` to your public origin (for example
`https://monitor.example.com`) when serving over HTTPS, including behind a
TLS-terminating proxy. It pins the CSRF origin check and marks session cookies
`Secure`. If the API sits behind a proxy, also set `TRUST_PROXY` so client IPs,
rate limits, and the origin check see the browser-facing host. Both variables
are documented in full in the
[Configuration Reference](configuration#security).

## Turning user control off

Set `WORKSPACE_DISABLED=true` to run without user control: no login, no roles,
and no Team page. Use this only when the monitor is already behind your own
access controls, since anyone who can reach it then has full access.
