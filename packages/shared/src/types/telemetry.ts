export const FRONTEND_TELEMETRY_EVENTS = [
  'interaction_after_idle',
  'page_view',
  'connection_switch',
] as const;

export type FrontendTelemetryEvent = (typeof FRONTEND_TELEMETRY_EVENTS)[number];

export const BACKEND_TELEMETRY_EVENTS = [
  'app_start',
  'db_connect',
  'db_switch',
  'mcp_tool_call',
] as const;

export type BackendTelemetryEvent = (typeof BACKEND_TELEMETRY_EVENTS)[number];

export type TelemetryEventType = FrontendTelemetryEvent | BackendTelemetryEvent;
