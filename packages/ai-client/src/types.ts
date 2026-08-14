export interface AiCompletionRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  text: string;
  tokensUsed: number;
  providerId: string;
  modelId: string;
}
