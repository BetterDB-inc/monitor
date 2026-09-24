// In production, API is served from same origin with /api prefix
// In development, API is on localhost:3001 without prefix
const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3001';

export function apiOrigin(): string {
  if (import.meta.env.PROD) {
    return window.location.origin;
  }
  return new URL(API_BASE, window.location.origin).origin;
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// Connection ID header name (must match backend CONNECTION_ID_HEADER)
const CONNECTION_ID_HEADER = 'x-connection-id';

// Module-level state for current connection ID
let currentConnectionId: string | null = null;

// Bounds for the opt-in `timeoutMs` (see FetchApiOptions). Values outside
// this range are clamped — a timeout must stay long enough to be useful
// but short enough that a hung request can't gate the UI forever.
export const MIN_API_TIMEOUT_MS = 1_000;
export const MAX_API_TIMEOUT_MS = 120_000;

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

export interface FetchApiOptions extends RequestInit {
  skipAuthRedirect?: boolean;
  /**
   * Opt-in timeout in ms, combined with any caller-provided `signal`.
   * Must fall within [MIN_API_TIMEOUT_MS, MAX_API_TIMEOUT_MS];
   * out-of-range values are clamped to the nearest bound
   * (0 is clamped to MIN_API_TIMEOUT_MS — omit the option to disable).
   * When omitted, no timeout is applied (pre-existing behaviour:
   * the request lives until it settles or the caller aborts).
   */
  timeoutMs?: number;
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

export class UnauthorizedError extends Error {
  constructor() {
    super('Sign in required');
    this.name = 'UnauthorizedError';
  }
}

export class ApiError extends Error {
  public readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export const AUTH_ROUTES = ['/login', '/register', '/invite'];

let authRedirectEnabled = false;

export function setAuthRedirectEnabled(enabled: boolean): void {
  authRedirectEnabled = enabled;
}

function isOnAuthRoute(): boolean {
  return AUTH_ROUTES.some((route) => {
    return window.location.pathname.startsWith(route);
  });
}

function redirectToLogin(): void {
  if (authRedirectEnabled === false) {
    return;
  }
  if (isOnAuthRoute()) {
    return;
  }
  const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
  window.location.assign(`/login?next=${next}`);
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

async function readBodyText(response: Response): Promise<string | null> {
  const rawBody = await response.text();
  return rawBody || null;
}

async function parseErrorPayload(response: Response): Promise<unknown> {
  let rawBody: string | null;
  try {
    rawBody = await readBodyText(response);
  } catch {
    return null;
  }
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

async function parseSuccessPayload<T>(response: Response): Promise<T> {
  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  let rawBody: string | null;
  try {
    rawBody = await readBodyText(response);
  } catch (error) {
    throw new Error(
      `Failed to read response body for ${response.url || 'request'}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!rawBody) {
    return undefined as T;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !contentType.includes('application/json') && !contentType.includes('+json')) {
    const snippet = rawBody.slice(0, 120);
    throw new Error(
      `Expected JSON but received "${contentType}" (status ${response.status}): ${snippet}`,
    );
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    const snippet = rawBody.slice(0, 120);
    throw new Error(`Failed to parse JSON response (status ${response.status}): ${snippet}`);
  }
}

function combineSignals(
  callerSignal?: AbortSignal | null,
  timeoutMs?: number,
): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  if (timeoutMs == null || !Number.isFinite(timeoutMs)) {
    return { signal: callerSignal ?? undefined, cleanup: () => {} };
  }

  const ms = Math.min(MAX_API_TIMEOUT_MS, Math.max(MIN_API_TIMEOUT_MS, timeoutMs));
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(
      typeof DOMException !== 'undefined'
        ? new DOMException(`Request timed out after ${ms}ms`, 'TimeoutError')
        : new Error(`Request timed out after ${ms}ms`),
    );
  }, ms);
  (timer as unknown as { unref?: () => void }).unref?.();

  const cleanup = () => clearTimeout(timer);

  if (!callerSignal) {
    return { signal: timeoutController.signal, cleanup };
  }

  // Prefer native composition when available.
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([callerSignal, timeoutController.signal]), cleanup };
  }

  // Fallback for runtimes without AbortSignal.any.
  const combined = new AbortController();
  const onAbort = () =>
    combined.abort(callerSignal.aborted ? callerSignal.reason : timeoutController.signal.reason);
  if (callerSignal.aborted || timeoutController.signal.aborted) {
    onAbort();
  } else {
    callerSignal.addEventListener('abort', onAbort, { once: true });
    timeoutController.signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: combined.signal,
    cleanup: () => {
      cleanup();
      callerSignal.removeEventListener('abort', onAbort);
      timeoutController.signal.removeEventListener('abort', onAbort);
    },
  };
}

export async function fetchApi<T>(endpoint: string, options?: FetchApiOptions): Promise<T> {
  const { timeoutMs, skipAuthRedirect, ...init } = options ?? {};
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };

  if (init?.body) {
    headers['Content-Type'] = 'application/json';
  }

  // Inject connection ID header if set
  if (currentConnectionId) {
    headers[CONNECTION_ID_HEADER] = currentConnectionId;
  }

  const { signal, cleanup } = combineSignals(init?.signal, timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...init,
      headers,
      credentials: 'include',
      signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        if (skipAuthRedirect !== true && authRedirectEnabled === true) {
          redirectToLogin();
        }
        throw new UnauthorizedError();
      }

      const errorPayload = await parseErrorPayload(response);

      if (response.status === 402) {
        if (isPaymentRequiredPayload(errorPayload)) {
          throw new PaymentRequiredError(errorPayload);
        }
      }

      const errorMessage = getErrorMessageFromPayload(errorPayload);
      throw new ApiError(
        errorMessage || `API error: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return await parseSuccessPayload<T>(response);
  } finally {
    cleanup();
  }
}
