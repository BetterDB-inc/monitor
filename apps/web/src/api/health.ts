import { fetchApi } from './client';
import { HealthResponse } from '../types/health';

export function fetchHealth(): Promise<HealthResponse> {
  return fetchApi<HealthResponse>('/health');
}
