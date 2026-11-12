/**
 * Partial unique indexes keying slow/command log rows by server run id when it
 * is known, so one process's entries are stored once whatever address they
 * were read through. Rows without a run id stay keyed by address through the
 * tables' own unique constraints.
 */
export const LOG_RUN_ID_UNIQUE_INDEXES = [
  { table: 'slow_log_entries', index: 'idx_slowlog_run_unique', columns: 'slowlog_id, source_run_id, connection_id' },
  {
    table: 'command_log_entries',
    index: 'idx_commandlog_run_unique',
    columns: 'commandlog_id, log_type, source_run_id, connection_id',
  },
] as const;
