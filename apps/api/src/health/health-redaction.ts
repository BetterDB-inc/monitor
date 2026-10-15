import type { DetailedHealthResponse, HealthResponse } from '@betterdb/shared';

/**
 * What an unauthenticated caller may learn from the public health endpoints
 * when sign-in is enforced: liveness, and (for the web app's startup guard)
 * whether license validation has finished. Never a connection's host, port,
 * engine version, modules, runtime capabilities, error text or config hazards
 * — together those are a ready-made target list (exact version → known CVE).
 */
export function redactHealth(health: HealthResponse): HealthResponse {
  return {
    status: health.status,
    database: { type: 'unknown', version: null, host: '', port: 0 },
    capabilities: null,
  };
}

export function redactDetailedHealth(health: DetailedHealthResponse): DetailedHealthResponse {
  return {
    ...redactHealth(health),
    uptime: health.uptime,
    timestamp: health.timestamp,
    ...(health.license ? { license: { isValidated: health.license.isValidated } } : {}),
  } as DetailedHealthResponse;
}
