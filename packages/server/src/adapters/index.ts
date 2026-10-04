/**
 * Provider adapters.
 *
 * Status of what is here: the adapter interface, the Anthropic adapter and
 * `resolveNeedsAi` are **implemented and tested**. Every other provider named in
 * the specification (OpenAI, Gemini, OpenRouter, Ollama) is **planned** and has no
 * file here.
 */

export {
  AdapterError,
  DEFAULT_ADAPTER_TIMEOUT_MS,
  DEFAULT_RETRY_POLICY,
  MAX_RETRY_AFTER_MS,
  backoffDelayMs,
  isRetryableStatus,
  retryAfterMsOf,
  validateRetryPolicy,
  type AdapterAnswerDraft,
  type AdapterDecideRequest,
  type AdapterDecideResult,
  type AdapterErrorCode,
  type AdapterHttpResponse,
  type AdapterReject,
  type AdapterUsage,
  type ClockLike,
  type FetchLike,
  type ModelAdapter,
  type RetryPolicy,
  type SleepLike,
} from './types.js';

export {
  ANTHROPIC_DECISION_SYSTEM_PROMPT,
  ANTHROPIC_DECISIONS_TOOL_NAME,
  ANTHROPIC_DECISIONS_TOOL_SCHEMA,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_PROVIDER_ID,
  ANTHROPIC_VERSION,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  DEFAULT_ANTHROPIC_MODEL,
  SETTINGS_KEY_ANTHROPIC_MODEL,
  buildAnthropicRequestBody,
  createAnthropicAdapter,
  scrubKey,
  type AnthropicAdapter,
  type AnthropicAdapterOptions,
} from './anthropic.js';

export {
  resolveNeedsAi,
  type ResolveNeedsAiDeps,
  type ResolveNeedsAiReject,
  type ResolveNeedsAiRejectType,
  type ResolveNeedsAiResult,
} from './resolve-needs-ai.js';
