# Adapters

Provider adapters for BYOK mode, in which BrowserReflex answers a `needs_ai` decision
itself with the user's own provider key instead of handing the question back to the
agent.

## Status

| Piece | State | Tests |
|---|---|---|
| `ModelAdapter` interface, `AdapterError`, retry policy | **implemented and tested** | `test/anthropic-adapter.test.ts` |
| Anthropic adapter (Messages API, forced tool call) | **implemented and tested** against recorded fixtures; no test has reached the live API | `test/anthropic-adapter.test.ts` |
| `resolveNeedsAi` | **implemented and tested** | `test/resolve-needs-ai.test.ts` |
| OpenAI, Gemini, OpenRouter, Ollama adapters | **planned** | none; no file exists |
| Wiring BYOK mode into `decide`, and a settings mode switch | **planned** | none; `decide` behaves exactly as it did |

`resolveNeedsAi` is not called by anything yet. It exists and is tested; the card that
calls it from `decide` is not written. Nothing in this directory changes how `decide`
behaves today.

## The interface

```ts
interface ModelAdapter {
  readonly provider: string;      // the key store account this adapter reads
  readonly defaultModel: string;  // used when nothing overrides it
  readonly timeoutMs: number;     // one request is bounded by this
  readonly retry: RetryPolicy;    // bounded, and never on a 4xx auth error
  decide(request: AdapterDecideRequest): Promise<AdapterDecideResult>;
}
```

`decide` takes typed `Question` values and returns typed answer drafts:

- `answers`: one draft per answered question, each with `questionId`, `value`,
  `confidence` and, for a choice, a `distribution` over every option id.
- `rejects`: every question with no usable answer, each with a reason and, where the
  schema named one, a field.
- `provider`, `model`, `latencyMs`, `attempts` and the provider's own `usage`.

A draft has **no `path` field**. An adapter says what the provider answered; only the
recording layer writes a path, and it writes `ai` because the provider produced the
answer. An adapter therefore cannot describe a decision it did not produce.

Nothing in an `AdapterDecideResult` or an `AdapterError` can hold a key: neither type has
a field a key could occupy.

## The Anthropic adapter

One POST to `https://api.anthropic.com/v1/messages`, with the `x-api-key`,
`anthropic-version: 2023-06-01` and `content-type: application/json` headers. Plain
`fetch` from Node 22 and the Node standard library, so no provider SDK is shipped and the
dependency table in `docs/DEPENDENCIES.md` is unchanged.

**Structured output by forced tool call.** The request declares one tool,
`submit_decisions`, whose `input_schema` is the shape of the answer, and forces it with
`tool_choice: { type: 'tool', name: 'submit_decisions' }`. The answer is read from the
`tool_use` block. Nothing parses prose and nothing extracts JSON out of a text block, so
there is no text to repair when the model answers in its own words. A response with no
such tool call is rejected as `invalid_output`, and `stop_reason: "max_tokens"` is named
in that rejection rather than left to be guessed at.

### The default model

`DEFAULT_ANTHROPIC_MODEL` in `anthropic.ts` is the only place the model id is written in
code. It is currently set to `claude-haiku-4-5-20251001`, the Haiku class model, because
this path runs on every decision the fast paths could not answer and the fastest and
cheapest model in the family should be the one that answers it.

A user overrides it in the `provider.anthropic.model` setting, and a caller may override
it per call. Precedence: per call, then the setting, then the adapter's own option, then
the constant. A model id that is not 1 to 128 characters of letters, digits, dot,
underscore or dash is refused rather than trimmed.

### Timeout and retry

- One request is bounded by `timeoutMs` (default 15 000 ms) through an `AbortController`.
  The timer is always cleared, so a finished request leaves no timer behind.
- `retry` defaults to three requests with a 250 ms initial delay, doubling, capped at
  4 000 ms. `validateRetryPolicy` refuses a policy it cannot honour instead of repairing
  it.
- **429 and 5xx are asked again.** Nothing else is. A 401 or 403 raises `auth` on the
  first response, because the same key would fail the same way, and a transport failure
  or a timeout raises immediately rather than being repeated.
- A `retry-after` header in seconds sets the wait, up to `MAX_RETRY_AFTER_MS` (30 000 ms).
  A larger value is ignored rather than followed: a retry budget that a response header
  can stretch is not bounded.

### The key

The key is read from the key store (`security/keys.ts`) on **every call**, under the
provider id `anthropic`, and is used for that one request. It is never held on the
adapter, never returned, never written down anywhere, and never logged: this directory
calls no logging function at all.

A message built from a provider error body is scrubbed of the key first, so a provider
that echoed the key back could not put it in an `AdapterError`. `scrubKey` is exported so
that behaviour can be tested on its own.

An adapter built without a key store raises `no_key` on every call. It never picks a key
store for itself, because a library reaching into the user's home directory is how a test
ends up reading someone's real keys.

## `resolveNeedsAi`

```ts
resolveNeedsAi(items, adapter, deps) → { answers, needs_human, rejects, provider, model, latency_ms, attempts }
```

It takes `needs_ai` items, asks the adapter for answers, validates them, and records the
valid ones by building the same payload an agent would send to `submit_answers` and
handing the batch to `executeSubmitAnswers`. Validation, the confidence threshold and the
stored shape are therefore the ones already tested for the agent path, and a valid answer
is recorded with path `ai`.

What comes back:

- `answers`: recorded with path `ai`.
- `needs_human`: recorded with path `ai` and flagged for review, because the confidence
  was below the threshold.
- `rejects`: one per question with no recorded answer, typed as `invalid_model_output`,
  `no_model_answer`, `adapter_error` or `submit_rejected`. A rejected question keeps its
  pending decision and stays in `needs_ai`.
- `model` is `null` when no model answered, and `attempts` is the number of requests made.

Nothing here throws for a provider failure or for an answer the schema rejects; both are
results. A caller that received an exception could not tell a pending decision from one
that was never offered.

## Known limits

- **No live API call has been made from a test.** The request shape follows the
  provider's published Messages API documentation, and every test runs against a
  recorded fixture through an injected `fetch`, an injected `sleep` and an injected
  clock. Nothing here is a claim about a real account, a real key or a real bill.
- **`resolveNeedsAi` has no caller.** It is not wired into `decide`, and no settings mode
  switch exists. That is a later card.
- **No cost table.** `usage` carries the provider's token counts and nothing derives a
  price from them, because a price table would be a guess about someone else's invoice.
- **The injected clock is monotonic and per call.** `latency_ms` is wall time around the
  whole call, so a call that waited out a 429 reports the wait as part of the latency.