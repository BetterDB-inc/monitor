// Pure helpers that turn API responses and errors into MCP tool results.
// Kept free of server start-up so they can be unit tested on their own.

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export class ApiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export function isLicenseError(
  data: unknown,
): data is { __licenseError: true; requiredTier: string; currentTier: string; upgradeUrl: string } {
  return data != null && typeof data === 'object' && (data as any).__licenseError === true;
}

export function licenseErrorResult(data: {
  requiredTier: string;
  currentTier: string;
  upgradeUrl: string;
}): string {
  return `This feature requires a ${data.requiredTier} license (current tier: ${data.currentTier}). Upgrade at ${data.upgradeUrl}`;
}

export function unavailableResult(
  featureLabel: string,
  requiresPro = true,
): {
  content: Array<{ type: 'text'; text: string }>;
} {
  const reason =
    requiresPro === true
      ? 'this monitor build does not include it (requires BetterDB Pro) or predates this tool — check license tier and monitor version.'
      : 'this monitor build predates this tool — update the monitor to use it.';
  return {
    content: [
      {
        type: 'text' as const,
        text: `${featureLabel} is unavailable: ${reason}`,
      },
    ],
  };
}

/** Compact JSON: agents pay for every token, and indentation is pure overhead. */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

const MISSING_ROUTE_RE = /^Cannot (GET|POST|PUT|PATCH|DELETE) /;

/** 404 from a missing route = this monitor build lacks the feature; any other 404 (unknown instance, session not on this instance) is surfaced verbatim. */
export function notFoundResult(err: ApiHttpError, featureLabel: string, requiresPro = true): ToolResult {
  const detail = err.detail ?? err.message;
  if (MISSING_ROUTE_RE.test(detail)) {
    return unavailableResult(featureLabel, requiresPro);
  }
  return { content: [{ type: 'text' as const, text: detail }], isError: true };
}

/** Non-404 API errors: surface the server's message (e.g. "CVE inspection is turned off…", "time range must not exceed 744 hours") instead of the generic HTTP status text. */
export function apiErrorResult(err: ApiHttpError): ToolResult {
  return { content: [{ type: 'text' as const, text: err.detail ?? err.message }], isError: true };
}
