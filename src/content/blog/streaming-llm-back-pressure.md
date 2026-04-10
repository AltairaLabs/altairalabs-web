---
title: "Bulletproofing Streaming LLM Calls: Three Layers of Back-Pressure"
description: "A single HTTP/2 reset can kill 100 concurrent LLM streams at once. Naively retrying them makes it worse. Here's the three-layer back-pressure stack we built in PromptKit — and the benchmark showing it kept us 6× more efficient than LangChain at 2000 concurrent."
date: 2026-04-10
tags: ["go", "production", "observability", "llms"]
author: "Charlie Holland"
draft: false
---

## The Catalyst

On our scheduled provider capability-matrix runs, `openai-gpt5-pro` kept dying with the same error:

```
stream chunk error: http2: response body closed
```

Not a rate limit. Not a config error. An upstream HTTP/2 stream reset, mid-request, after the request had already been accepted and was streaming tokens back. We'd see it on one run, not on the next, then on a cluster of three in a row. Our capability matrix isn't a load test — it's a nightly smoke run — and we were still hitting it.

The problem is that a single h2 connection drop doesn't kill *one* request. HTTP/2 multiplexes many streams onto the same connection, so when the underlying TCP connection resets, **every stream sharing it dies at once**. At production concurrency that's 50, 100, or more simultaneous failures from a single upstream hiccup.

The naive fix is "retry the request." For streaming LLM calls, that's dangerously wrong — and fixing it properly turned into a three-phase back-pressure stack (plus a fourth phase nobody asked for), extended across every provider we ship, and wrapped in a benchmark suite to prove it didn't cost us anything.

This post is the deep dive.

## Why Streaming Retry Is a Trap

Three things make retrying an in-flight LLM stream fundamentally different from retrying a REST call:

**Chunks already forwarded.** If you've already streamed 200 tokens to the client's WebSocket and the upstream dies, a naive retry produces a *second* stream — and the client sees duplicate content. Worse, the two streams can diverge: LLMs are non-deterministic, so the retry will almost certainly produce a different answer. The user ends up reading "the capital of France is Paris, which… the capital of France is a beautiful city called Lyon." Unrecoverable confusion.

**Thundering herd on a single failure.** If one h2 connection reset takes out 100 streams at once, and every one of them retries with the same backoff, you get 100 synchronized reconnect attempts against the same broken endpoint. The upstream — if it's recovering — gets hammered just as it's trying to come back up.

**Goroutine amplification.** Each in-flight stream in Go is more than a request: it's a goroutine, an idle timer, channel buffers, and a frame reader. At 1000+ concurrent streams this adds up fast, even though the actual HTTP/2 layer only needs a handful of connections. Uncontrolled, your process can be holding thousands of goroutines while the upstream is handling dozens of actual sockets.

Three different failure modes. Three different back-pressure primitives. That's the shape of the stack.

![Three-layer back-pressure stack for streaming LLM calls: a concurrency semaphore gates slot acquisition before any HTTP work, a retry budget gates reconnection attempts across calls, and a retry policy runs the per-call attempt loop. Rejected requests surface context_canceled, deadline_exceeded, budget_exhausted, or a classified retryable error.](/images/blog/streaming-back-pressure-stack.svg)

## The Three-Layer Back-Pressure Stack

### Phase 1 — Bounded Pre-First-Chunk Retry ([#855](https://github.com/AltairaLabs/PromptKit/pull/855))

The safe window. If the upstream fails *before* any content chunk has been forwarded downstream, we can retry with zero observable duplication — the caller never saw the aborted attempt.

`OpenStreamWithRetry` orchestrates this. It calls `Do()` on the HTTP client, then peeks the first SSE event. On success, the buffered first event is replayed into a composite reader so downstream SSE parsers see a contiguous stream. On a retryable failure, the body is closed and the attempt retries with full jitter.

Classifying "retryable" started out as a list of error-message substrings. That got ugly fast — every provider formats its errors slightly differently, and string matching is the kind of code that silently stops working when a dependency rewrites its error text. A follow-up refactor ([#923](https://github.com/AltairaLabs/PromptKit/pull/923)) replaced it with structured provider error types and an `errors.As`-based check:

```go
// ProviderHTTPError wraps non-2xx HTTP responses (status, URL, body, provider).
// ProviderTransportError wraps connection-level failures (h2 resets, TCP resets, EOF).
// IsTransient classifies via type assertion — no string parsing.
if providers.IsTransient(err) {
    // retryable: close body, back off with jitter, try again
}
```

The classifier is deliberately narrow. Context cancellation and `context.DeadlineExceeded` are *never* transient — if the caller gave up, we give up. Structured types also pay off beyond retry: the capability matrix now classifies Gemini 503s and h2 drops as *skipped* (via the same `IsTransient` check) instead of counted as failures, because transient upstream flakiness isn't a PromptKit bug.

Config is per-provider, opt-in:

```yaml
stream_retry:
  enabled: true          # default: false
  max_attempts: 2
  initial_delay: 250ms
  max_delay: 2s
```

The observability came first. Four metrics went in with Phase 1, all direct-update (more on why below):

- `promptkit_streams_in_flight{provider}` — gauge, primary HPA signal
- `promptkit_provider_calls_in_flight{provider}` — gauge
- `promptkit_stream_first_chunk_latency_seconds{provider}` — histogram with reasoning-model buckets (0.1s..5min)
- `promptkit_stream_retries_total{provider,outcome}` — counter

The `first_chunk_latency` histogram turned out to be the most useful: it's the empirical answer to "how often is pre-first-chunk retry actually catching failures in the wild?" If the distribution shows most successful streams start in under a second, the retry window is doing its job. If it's blown out, the window is too narrow.

### Phase 2 — Cross-Call Retry Budget ([#856](https://github.com/AltairaLabs/PromptKit/pull/856))

Phase 1 is per-call. Under load, per-call isn't enough.

The scenario: an h2 connection reset kills 100 streams simultaneously. All 100 enter Phase 1 retry. All 100 dial again at roughly the same time. The upstream sees a thundering herd just as it's trying to recover.

The fix is gRPC's [retry throttling](https://github.com/grpc/proposal/blob/master/A6-client-retries.md) pattern: a token bucket per `(provider, host)` that caps the rate at which retries actually re-dial. Only retries consume tokens — the initial attempt of every request is always allowed through, because we don't want the budget to gate fresh traffic.

```yaml
stream_retry:
  enabled: true
  max_attempts: 2
  budget:
    rate_per_sec: 5    # sustained refill
    burst: 10          # max accumulated tokens
```

Two design decisions worth calling out:

**Per-provider scope.** A gpt-5-pro outage can't starve gpt-4o retries. If it could, a single misbehaving provider would cascade into everything else.

**Empty budget fails fast, doesn't block.** When the bucket is drained, the retry immediately returns the last error. Blocking would stack goroutines on a starved bucket, which is exactly the failure mode we're trying to prevent.

The new gauge — `promptkit_stream_retry_budget_available{provider,host}` — is sampled on every retry decision. A provider whose budget is trending toward zero is about to start failing retries, and that's a warning signal that should fire long before the incident does.

### Phase 3 — Total In-Flight Semaphore ([#858](https://github.com/AltairaLabs/PromptKit/pull/858))

Phases 1 and 2 bound the number of *retries*. They don't bound the number of *streams* a provider can hold open.

At 1000+ concurrent streams, goroutine count, idle timers, and channel buffers can dominate even when only a handful of HTTP/2 connections are actually needed. Uncontrolled goroutine growth is a real outage vector: the process starts slow, GC pauses grow, scheduling latency increases, and eventually the OS kills it.

The semaphore is a simple `golang.org/x/sync/semaphore` wrapped in a context-aware `Acquire`:

```yaml
stream_max_concurrent: 100   # 0 = unlimited (current default)
```

Three things make this work cleanly:

- **Context-driven blocking.** `Acquire(ctx, 1)` respects the caller's deadline. A short timeout means "reject me quickly if full"; a long one means "queue". The caller chooses, not the primitive.
- **Slot acquired *before* any HTTP work.** No goroutine is spawned, no buffer allocated, no retry driver entered, until the slot is held. Saturation rejects cheaply.
- **Release in a defer with a paired flag.** The slot is released in the stream goroutine's defer on the success path, or via a `slotReleased` flag in a deferred error handler. The pattern guarantees pairing — same trick used for the `streams_in_flight` gauge.

`promptkit_stream_concurrency_rejections_total{provider,reason}` counts rejections, and the `reason` label distinguishes `context_canceled` (the caller gave up) from `deadline_exceeded` (the caller's timeout hit while waiting). Both are actionable: sustained spikes in either mean the semaphore is undersized or upstream is saturated.

## The Fourth Phase Nobody Asked For: Mid-Stream Reset Retry ([#895](https://github.com/AltairaLabs/PromptKit/pull/895))

After Phases 1–3 shipped, a GitHub issue asked for "dedup-aware mid-stream resume" — the ability to reconnect to a running stream and skip already-received chunks. It would be the ideal solution, and it turned out to be impossible.

**Zero LLM providers support resume tokens.** Without provider cooperation, there is no way to reconnect to a running stream and dedup already-received content. The feature described in the issue couldn't exist.

The pragmatic alternative we shipped instead: when a stream fails *after* content has been forwarded, and the provider is configured with `retry_window: always`, the relay emits a new chunk type — `StreamChunk{Reset: true}` — that tells the consumer to **throw away everything it's accumulated so far**. Content, tool calls, cost info, all of it. Then the full request runs from scratch. The retry produces a completely new response (LLMs are non-deterministic, so the new answer will differ) and costs extra tokens.

![Timeline of two streaming retry windows. The pre-first-chunk window catches failures before any content is forwarded downstream and retries invisibly. The mid-stream reset window catches failures after content has been forwarded, emits a Reset chunk so the consumer discards accumulated state, and retries the full request from scratch at the cost of extra tokens.](/images/blog/streaming-retry-windows.svg)

Off by default, because those tokens aren't free. Operators opt in per provider when the cost of extra tokens is cheaper than the cost of an unrecoverable error:

```yaml
providers:
  - id: openai-gpt5-pro
    stream_retry:
      enabled: true
      max_attempts: 2
      retry_window: always       # default: pre_first_chunk
      budget:
        rate_per_sec: 5
        burst: 10
```

Strictly better than the current behavior (unrecoverable error), no provider cooperation required, no pretending to do something that can't be done. The Reset chunk gives the consumer pipeline a clean "start over" signal it already knows how to handle, because pipeline stages already track accumulated state.

## Wiring It Across the Fleet

The architecture paid off when we turned it on everywhere. One retry driver, every provider, no per-provider retry logic:

- **OpenAI Chat Completions + Responses API** ([#855](https://github.com/AltairaLabs/PromptKit/pull/855), [#856](https://github.com/AltairaLabs/PromptKit/pull/856)) — both paths delegate to `OpenStreamWithRetry`
- **Claude and VLLM** ([#868](https://github.com/AltairaLabs/PromptKit/pull/868))
- **Bedrock eventstream** ([#897](https://github.com/AltairaLabs/PromptKit/pull/897)) — the AWS SDK's eventstream decoder wired through the retry driver
- **Gemini and Ollama** ([#871](https://github.com/AltairaLabs/PromptKit/pull/871)) — via a pluggable `FrameDetector` interface, because their non-SSE framing needed a different first-frame peek
- **Capability matrix providers** ([#922](https://github.com/AltairaLabs/PromptKit/pull/922)) — the nightly smoke run now exercises the same retry stack as production
- **`ToolProvider` across every provider** ([#928](https://github.com/AltairaLabs/PromptKit/pull/928)) — tool-calling chains get the same semantics
- **TTS and STT stages in the audio pipeline** ([#900](https://github.com/AltairaLabs/PromptKit/pull/900)–[#902](https://github.com/AltairaLabs/PromptKit/pull/902)) — voice agents get retry semantics identical to text, because real-time audio is just another streaming call

The pluggable `FrameDetector` deserves a one-sentence callout: it's what lets the retry driver handle SSE, JSON-lines, and binary framings without any format-specific code in the retry logic itself. The detector's job is "tell me when the first frame has arrived." Everything else is shared.

## The Benchmarks That Proved It Didn't Cost Anything

The obvious counter-argument to all this machinery is "sure, it's safer, but is it still fast?"

Cue [#919](https://github.com/AltairaLabs/PromptKit/pull/919) — the efficiency benchmark suite comparing PromptKit, LangChain, Vercel AI SDK, and Strands Agents on a realistic tool-calling profile. Mock upstream returns tool calls, frameworks execute tools against a mock tool endpoint, feed the results back, and stream the final response. Measured RSS and CPU, computed cost-per-million-requests against a c6g.xlarge reference ($0.136/hr).

![Resident memory at 100, 500, 1000, and 2000 concurrent streams across four frameworks. PromptKit stays flat near 350 MB even at 2000. LangChain grows to 1.3 GB at 1000 and OOMs at 2000. Vercel AI SDK holds around 1 GB. Strands Agents climbs past 4 GB at 2000.](/images/blog/streaming-benchmark-memory.svg)

**Resident memory (MB, lower is better)**

| Concurrent | PromptKit | LangChain | Vercel AI | Strands |
|---|---|---|---|---|
| 100  | **74**  | 220   | 370   | 458   |
| 500  | **210** | 688   | 903   | 1,229 |
| 1000 | **348** | 1,331 | 1,024 | 2,355 |
| 2000 | **607** | OOM   | 1,024 | 4,608 |

**CPU utilization (%, lower is better)**

| Concurrent | PromptKit | LangChain | Vercel AI | Strands |
|---|---|---|---|---|
| 100  | **29** | 67 | 54  | 54 |
| 500  | **29** | 98 | 140 | 96 |
| 1000 | **29** | 99 | 131 | 99 |
| 2000 | **29** | —  | 115 | 99 |

**Cost per million requests (USD, lower is better)**

| Concurrent | PromptKit | LangChain | Vercel AI | Strands |
|---|---|---|---|---|
| 100  | **$0.03** | $0.14 | $0.06 | $0.09 |
| 500  | **$0.03** | $0.11 | $0.05 | $0.08 |
| 1000 | **$0.03** | $0.12 | $0.03 | $0.10 |
| 2000 | **$0.03** | —     | $0.04 | $0.33 |

PromptKit holds **29% CPU and $0.03 per million requests from 100 concurrent all the way to 2000**. LangChain OOMs at 2000. Strands uses 6.6× more memory at 1000 concurrent. The retry stack isn't overhead — it's *why* PromptKit stays flat under load. Unbounded goroutines and synchronized reconnects are exactly what the other frameworks are doing, and the memory curve shows it.

The benchmark is in-tree, the measurement harness is reproducible, and CI now runs perf-regression checks on every PR ([#920](https://github.com/AltairaLabs/PromptKit/pull/920), [#921](https://github.com/AltairaLabs/PromptKit/pull/921)). We'll notice if a future commit regresses — the perf job fails the PR if RSS or CPU exceeds the baseline by more than the configured tolerance.

## Bonus: 40% CPU Reduction from One `sync.Map` ([#917](https://github.com/AltairaLabs/PromptKit/pull/917))

While we were benchmarking, CPU profiles showed 34% of CPU was going to JSON schema compilation inside `sdk.Open()`. The same pack file was being parsed and schema-compiled on every single call — no cache, because the original assumption was that `sdk.Open()` was a one-shot operation.

It wasn't. High-concurrency callers were opening the same pack file repeatedly, and the schema compilation was blowing up the CPU profile.

The fix is one `sync.Map` keyed by absolute pack path:

| Metric | Before | After |
|---|---|---|
| CPU utilization | 68% | 41% (-40%) |
| Schema compilation CPU | 34% | 0% (eliminated) |
| Throughput | 920 rps | 920 rps (now I/O bound) |

Throughput didn't move because the localhost benchmark is network-bound above a certain CPU headroom. On real infrastructure, the freed CPU translates directly to higher concurrent session capacity. The `*pack.Pack` is immutable after construction, so sharing it across goroutines is safe by construction.

Small PR. Big win. The kind of optimization you only find when you're running at scale enough to hit it.

## Design Principles That Came Out of It

A few things that ended up mattering across every phase:

**Direct-update metrics over events.** Phase 2 was originally going to emit `stream.retry.attempted` and `stream.retry.budget_exhausted` events on the event bus. We didn't, because the event bus drops events under exactly the load conditions where retry metrics matter most. Direct-update Prometheus gauges and counters update at the source and are drop-immune. Events are great for consumer-driven reactions; metrics are what you need for autoscaling and alerts.

**Nil is a no-op.** Every new primitive — `RetryBudget`, the semaphore, `StreamRetryPolicy` — treats `nil` as "feature disabled". No config flags, no `if enabled { ... }` sprinkled through provider code. A provider that hasn't opted in looks exactly like it did before the stack existed. Backwards-compat by construction.

**Acquire before work.** Slots, budget tokens, retry classification — all acquired before any HTTP work happens. A rejected request allocates nothing, spawns no goroutine, and returns an error cheaply. This is what makes the semaphore a real back-pressure mechanism instead of a counter that gets incremented after the damage is done.

**Context-driven blocking.** Every primitive respects the caller's context. Short deadline → fail fast. Long deadline → queue. No custom timeout fields inside the primitives themselves, because callers already know their own tolerances.

## What's Next

- **`promptkit_http_conns_in_use` gauge** via `httptrace.ClientTrace`. The streams-in-flight gauge tells us how many streams we're holding; what we want next is how many actual HTTP/2 connections are in use underneath.
- **Connection pool config exposure.** `MaxConnsPerHost` is currently implicit. Making it configurable per-provider lets operators tune it against their actual upstream behavior.
- **Auto-tuning the retry budget.** The budget rate is currently a config value. The natural evolution is to derive it from observed failure rates so that operators don't have to tune it by hand.
- **Applying the stack to the non-streaming path** for symmetry. Today the retry primitives are scoped to streaming calls because that's where the pain was, but there's no reason the same machinery shouldn't cover unary calls too.

## The Takeaway

Streaming is the default for production LLM calls, and production LLM calls fail in messy, correlated ways. A single h2 reset can knock out a hundred streams at once. The naive responses — retry blindly, swallow the error, crash the process — all make things worse. What works is three primitives stacked on top of each other: a per-call retry window narrow enough to guarantee no duplication, a cross-call budget to tame thundering herds, and a concurrency semaphore to bound goroutine growth.

Wrap it in direct-update metrics that don't get dropped under load. Make every primitive nil-safe and backwards-compatible. Acquire before work. Let the caller's context control the timeouts. And validate with a benchmark that shows you didn't trade safety for speed.

The code is open source at [AltairaLabs/PromptKit](https://github.com/AltairaLabs/PromptKit) — the key PRs are [#855](https://github.com/AltairaLabs/PromptKit/pull/855) (Phase 1), [#856](https://github.com/AltairaLabs/PromptKit/pull/856) (Phase 2), [#858](https://github.com/AltairaLabs/PromptKit/pull/858) (Phase 3), [#895](https://github.com/AltairaLabs/PromptKit/pull/895) (mid-stream reset), and [#919](https://github.com/AltairaLabs/PromptKit/pull/919) (the efficiency benchmark). Provider config reference lives in the [runtime config docs](https://promptkit.altairalabs.ai/sdk/reference/runtime-config/).
