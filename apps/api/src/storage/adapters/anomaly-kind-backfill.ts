const LEGACY_SUSTAINED_DEGRADATION_PREFIX = 'Sustained P99 latency degradation';
const LEGACY_RESYNC_FILTER = `metric_type = 'resync_escalation' AND replica_addr IS NULL AND message LIKE 'Replica %'`;

const COMMAND_P99_KIND_BACKFILL = [
  `UPDATE anomaly_events SET kind = 'sustained_degradation'
    WHERE metric_type = 'command_p99' AND kind IS NULL
      AND message LIKE '${LEGACY_SUSTAINED_DEGRADATION_PREFIX}%'`,
  `UPDATE anomaly_events SET kind = 'upgrade_regression'
    WHERE metric_type = 'command_p99' AND kind IS NULL`,
];

export const SQLITE_LEGACY_ANOMALY_BACKFILL = [
  ...COMMAND_P99_KIND_BACKFILL,
  `UPDATE anomaly_events SET replica_addr = substr(message, 9, instr(substr(message, 9), ' ') - 1)
    WHERE ${LEGACY_RESYNC_FILTER} AND instr(substr(message, 9), ' ') > 1`,
];

export const POSTGRES_LEGACY_ANOMALY_BACKFILL = [
  ...COMMAND_P99_KIND_BACKFILL,
  `UPDATE anomaly_events SET replica_addr = split_part(substr(message, 9), ' ', 1)
    WHERE ${LEGACY_RESYNC_FILTER} AND position(' ' in substr(message, 9)) > 1`,
];
