export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export type LicenseErrorPayload = {
  __licenseError: true;
  requiredTier: string;
  currentTier: string;
  upgradeUrl: string;
};

const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function isJsonResponse(res: { headers: { get(name: string): string | null } }): boolean {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json');
}

export function isLicenseError(data: unknown): data is LicenseErrorPayload {
  return (
    data != null &&
    typeof data === 'object' &&
    (data as Record<string, unknown>).__licenseError === true
  );
}

export function licenseErrorResult(data: Pick<LicenseErrorPayload, 'requiredTier' | 'currentTier' | 'upgradeUrl'>): string {
  return `This feature requires a ${data.requiredTier} license (current tier: ${data.currentTier}). Upgrade at ${data.upgradeUrl}`;
}

export function resolveInstanceId(activeInstanceId: string | null, overrideId?: string): string {
  if (overrideId === '') {
    throw new Error('Instance ID override must not be an empty string.');
  }
  const id = overrideId || activeInstanceId;
  if (!id) {
    throw new Error('No instance selected. Call list_instances then select_instance first.');
  }
  if (!INSTANCE_ID_RE.test(id)) {
    throw new Error(`Invalid instance ID: ${id}`);
  }
  return id;
}

export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function formatProposalText(data: {
  proposal_id: string;
  status: string;
  expires_at: number;
  warnings: string[];
}): ToolResult {
  const expiresAtIso = new Date(data.expires_at).toISOString();
  const lines = [
    `Proposal created: ${data.proposal_id}`,
    `Status: ${data.status}`,
    `Expires at: ${expiresAtIso}`,
  ];
  if (data.warnings && data.warnings.length > 0) {
    lines.push(`Warnings: ${data.warnings.join('; ')}`);
  }
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

export function getArgValue(args: string[], flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) {
    return args[i + 1];
  }
  return fallback;
}

export function parseErrorResponse(errText: string, status: number): string {
  let message = `Request failed with status ${status}`;
  try {
    const parsed = JSON.parse(errText) as Record<string, unknown>;
    if (parsed.error) message = String(parsed.error);
    else if (parsed.message) message = String(parsed.message);
  } catch {
    if (errText) message = errText;
  }
  return message;
}
