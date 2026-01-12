import { fetchApi } from './client';
import type { ChatRequest, ChatResponse } from '@betterdb/shared';

export const aiApi = {
  chat: (request: ChatRequest) => fetchApi<ChatResponse>('/ai/chat', {
    method: 'POST',
    body: JSON.stringify(request),
  }),

  health: () => fetchApi<{ status: string }>('/ai/health'),
};
