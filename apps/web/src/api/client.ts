// In production, API is served from same origin with /api prefix
// In development, API is on localhost:3001 without prefix
const API_BASE = import.meta.env.PROD
  ? '/api'
  : 'http://localhost:3001';

// Connection ID header name (must match backend CONNECTION_ID_HEADER)
const CONNECTION_ID_HEADER = 'x-connection-id';

// Module-level state for current connection ID
let currentConnectionId: string | null = null;

/**
 * Set the current connection ID for all subsequent API requests.
 * This is called by the ConnectionContext when the user switches connections.
 */
export function setCurrentConnectionId(connectionId: string | null): void {
  currentConnectionId = connectionId;
}

/**
 * Get the current connection ID.
 */
export function getCurrentConnectionId(): string | null {
  return currentConnectionId;
}

export class PaymentRequiredError extends Error {
  public readonly feature: string;
  public readonly currentTier: string;
  public readonly requiredTier: string;
  public readonly upgradeUrl: string;

  constructor(data: {
    message: string;
    feature: string;
    currentTier: string;
    requiredTier: string;
    upgradeUrl: string;
  }) {
    super(data.message);
    this.name = 'PaymentRequiredError';
    this.feature = data.feature;
    this.currentTier = data.currentTier;
    this.requiredTier = data.requiredTier;
    this.upgradeUrl = data.upgradeUrl;
  }
}

function getErrorMessageFromPayload(payload: unknown): string | null {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    return payload.trim() || null;
  }

  if (Array.isArray(payload)) {
    const nestedMessages = payload
      .map(getErrorMessageFromPayload)
      .filter((message): message is string => Boolean(message));

    return nestedMessages.length > 0 ? nestedMessages.join(', ') : null;
  }

  if (typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;

    const message = getErrorMessageFromPayload(obj.message);
    if (message) {
      return message;
    }

    const detail = getErrorMessageFromPayload(obj.detail);
    if (detail) {
      return detail;
    }

    const reason = getErrorMessageFromPayload(obj.reason);
    if (reason) {
      return reason;
    }

    const error = getErrorMessageFromPayload(obj.error);
    if (error) {
      return error;
    }
  }

  return null;
}

function isPaymentRequiredPayload(payload: unknown): payload is {
  message: string;
  feature: string;
  currentTier: string;
  requiredTier: string;
  upgradeUrl: string;
} {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const data = payload as Record<string, unknown>;
  return (
    typeof data.message === 'string' &&
    typeof data.feature === 'string' &&
    typeof data.currentTier === 'string' &&
    typeof data.requiredTier === 'string' &&
    typeof data.upgradeUrl === 'string'
  );
}

async function parseErrorPayload(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

export async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    ...options?.headers as Record<string, string>,
  };

  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  // Inject connection ID header if set
  if (currentConnectionId) {
    headers[CONNECTION_ID_HEADER] = currentConnectionId;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    signal: options?.signal,
  });

  if (!response.ok) {
    const errorPayload = await parseErrorPayload(response);

    if (response.status === 402) {
      if (isPaymentRequiredPayload(errorPayload)) {
        throw new PaymentRequiredError(errorPayload);
      }
    }

    const errorMessage = getErrorMessageFromPayload(errorPayload);
    throw new Error(errorMessage || `API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
