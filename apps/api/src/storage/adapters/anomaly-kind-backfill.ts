const LEGACY_SUSTAINED_DEGRADATION_PREFIX = 'Sustained P99 latency degradation';

export const BACKFILL_COMMAND_P99_KIND_SQL = `
  UPDATE anomaly_events SET kind = 'sustained_degradation'
    WHERE metric_type = 'command_p99' AND kind IS NULL
      AND message LIKE '${LEGACY_SUSTAINED_DEGRADATION_PREFIX}%';
  UPDATE anomaly_events SET kind = 'upgrade_regression'
    WHERE metric_type = 'command_p99' AND kind IS NULL;
`;
