// The Anthropic boundary of the chat agent (#19). The service depends only on `AnthropicLike`, so
// tests inject a scripted client; production builds the official SDK client from ANTHROPIC_API_KEY.
// The key goes into the SDK's x-api-key header and nowhere else: the SDK's own logger is off, and
// the chat service logs only an error's class and HTTP status.
import Anthropic from '@anthropic-ai/sdk';

export interface AnthropicLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number; signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
}

export function createAnthropicClient(
  apiKey: string,
  opts: { baseURL?: string; maxRetries?: number } = {},
): AnthropicLike {
  return new Anthropic({
    apiKey,
    logLevel: 'off',
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
  });
}
