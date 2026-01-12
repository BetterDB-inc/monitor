// In production, API is served from same origin with /api prefix
// In development, API is on localhost:3001 without prefix
const API_BASE = import.meta.env.PROD
  ? '/api'
  : 'http://localhost:3001';

export async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
