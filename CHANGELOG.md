# Changelog

## Unreleased

### Added

- **MONITOR capture sessions** — on-demand command capture for
  Valkey / Redis instances with a live tail, post-capture filters,
  JSON / CSV export, four-axis cross-reference against connection
  history, and a pre-flight modal that surfaces provider warnings,
  ACL gaps (with copy-to-clipboard `ACL SETUSER` snippet), health
  signals, and a throughput estimate. Cluster fan-out captures one
  primary at a time or all primaries in parallel into a single
  logical session. Pro+: anomaly-triggered captures from
  `/anomalies`, scheduled captures (interval picker by default,
  `Advanced` cron field), capture-vs-capture diff. Webhooks for
  every lifecycle transition (`monitor.session.started` /
  `completed` / `truncated` / `skipped`, `monitor.trigger.created`).
  Server-side `MONITOR_REDACT_VALUES` toggle scrubs write-command
  payloads at the source. Data retention follows the existing
  tier-based sweep (community 7 d, Pro 90 d, enterprise 365 d).
  See [`docs/monitor.md`](docs/monitor.md).

### Removed

- The `MONITOR_DEV_PREVIEW` / `VITE_MONITOR_DEV_PREVIEW` gates that
  hid the MONITOR routes and UI during the staged rollout. The
  feature is now always available; license tier and the existing
  demo-mode guard are the only gates.
