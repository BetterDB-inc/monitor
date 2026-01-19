// In production, API is served from same origin with /api prefix
// In development, API is on localhost:3001 without prefix
const API_BASE = import.meta.env.PROD
  ? '/api'
  : 'http://localhost:3001';

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

export async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    ...options?.headers as Record<string, string>,
  };

  // Only set Content-Type if there's a body
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 402) {
      const errorData = await response.json();
      throw new PaymentRequiredError(errorData);
    }
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
