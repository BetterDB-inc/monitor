export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
}

export interface ChatResponse {
  response: string;
}

export interface IndexDocsRequest {
  path: string;
}

export interface IndexDocsResponse {
  success: boolean;
  indexed?: number;
  failed?: number;
}

export interface AiHealthResponse {
  status: 'ok' | 'error';
  ollamaAvailable?: boolean;
  vectorStoreInitialized?: boolean;
}
