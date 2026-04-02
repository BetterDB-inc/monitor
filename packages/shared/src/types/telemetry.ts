export const FRONTEND_TELEMETRY_EVENTS = [
  'interaction_after_idle',
  'page_view',
  'connection_switch',
] as const;

export type FrontendTelemetryEvent = (typeof FRONTEND_TELEMETRY_EVENTS)[number];
