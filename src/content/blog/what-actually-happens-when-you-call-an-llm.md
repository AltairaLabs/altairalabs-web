---
title: "What Actually Happens When You Call an LLM API"
description: "Inside the token-by-token generation loop, the KV cache, vLLM's PagedAttention, and why 'just retry the request' is harder than it looks when the API you're calling isn't stateless at all."
date: 2026-04-10
tags: ["llms", "infrastructure", "gpu", "inference"]
author: "Charlie Holland"
draft: false
---

## It Looks Like a REST Call

I've had this conversation three times in the last month. An engineering team is building something on top of an LLM API, they hit a failure mode that doesn't fit any of their existing mental models — a stream that dies halfway through, a retry that comes back with a completely different answer, a latency spike that doesn't line up with any dashboard — and they come to me genuinely confused because *it's just an HTTP call*. They've instrumented the request. They've checked the load balancer. They've ruled out their own code. The thing on the other end is behaving like no HTTP service they've ever operated.

The problem is always the same. They're looking at it like this:

```
POST /v1/messages
  → request
  → response
```

Client sends a prompt, server sends back text. Feels like any other REST endpoint. Retries are safe. Load balancers are stateless. Scaling is a matter of adding more workers. It's the comfortable mental model every engineer carries when they start building on top of OpenAI, Anthropic, or a self-hosted model.

It is also completely wrong.

An LLM API call is not a function. It is a **long-lived, stateful, real-time computation running on a specific GPU**, producing its output one token at a time, over the course of anywhere from a hundred milliseconds to several minutes. The thing you're calling looks nothing like a web service. It looks like a physics simulation — one that accretes state as it runs and cannot be meaningfully paused, migrated, or resumed.

This post is the tour I end up giving those teams. What actually happens on the other end of that HTTP connection, why LLM responses inherently stream rather than arrive in one shot, why prompt caching is a line item on your bill, and why something as simple as "retry the failed request" turns into a hard engineering problem the moment you understand the shape of the thing you're retrying.

## One Token at a Time

Transformer language models generate text one token at a time. This is not a detail — it is the entire shape of the computation.

A *token* is roughly a word or a word-fragment. Models have vocabularies of 30,000 to 200,000 of them. "Explain Kubernetes in one sentence" tokenises to maybe six or seven tokens before the model ever sees it. Everything that follows operates at token granularity — not characters, not words, tokens.

When you send that prompt to a model, the system doesn't go away and come back with a complete answer. It runs a loop:

1. **Feed the prompt into the model.** Every token in the input flows through every layer of the neural network — 32, 80, 120, however many layers the model has — and at the end, the model produces a score for every possible next token in its vocabulary. Bigger score means "more likely to come next." This one trip through the model is called a **forward pass**.
2. **Pick one token based on those scores.** The strategy for picking is called **sampling**. Greedy sampling picks the highest-scoring token. Temperature-based sampling turns the scores into probabilities and rolls a weighted dice. Top-k and top-p are variations on the same idea. Whichever strategy you use, the result is exactly one token.
3. **Append the picked token to the end of the sequence.** The input is now one token longer than it was a moment ago.
4. **Run another forward pass over the new, longer sequence.** Get a new set of scores for the next token.
5. **Sample the next token. Append it. Run another forward pass. Repeat.**
6. **Stop** when the model picks a special end-of-sequence token, or when the sequence hits a configured max-length limit.

Every single token in the response is its own forward pass through the model. A 200-token answer is 200 forward passes. A 4,000-token answer is 4,000 forward passes. The model is *not* holding the full answer in its head waiting to ship it out; it is computing each token in real time based on everything that came before.

This is the fundamental reason LLMs stream.

> The answer does not exist in advance. There is no complete response sitting in a buffer waiting to be sent. The server is actively computing every token as you read the previous one.

"Streaming" as a feature is not a UX choice made for perceived responsiveness. It is the only way to return data that is still being created. The alternative — buffer every token until the model hits stop, then return the whole thing — is strictly worse in every dimension except "the response shape looks like a normal REST call." It adds latency equal to the full generation time before the caller sees anything, and it burns exactly the same GPU time under the hood.

## The KV Cache: Where the State Lives

There's a question lurking inside the generation loop: if every forward pass has to see *all* the previous tokens, doesn't that get extremely expensive as the sequence grows? A 1,000-token response on a 1,000-token prompt would do 1,000 forward passes over sequences averaging 1,500 tokens each. That's a lot of apparently-redundant work.

It would be — except for the **KV cache**.

Inside every layer of the model, there's an operation called **attention**. It's the bit that lets each position in the sequence look back at every previous position and mix information from them together. For each token, attention computes three small vectors (query, key, and value — `Q`, `K`, `V`), and the output for position `t` is a weighted combination of all the prior values, where the weights come from how well the current query matches each prior key.

The crucial property — and the whole reason the KV cache exists — is that `K` and `V` for a given token depend only on *that one token* and a set of weights frozen at training time. They don't depend on anything else in the sequence. Once you've computed `K_3` and `V_3` for the third token, they are the same vectors a hundred steps later. The query is the odd one out: it always belongs to the *current* position and gets thrown away as soon as that step's attention output is computed.

So the model caches every `K` and `V` it has ever computed for this request. Every time it generates a new token, it only needs to compute one new `Q`, one new `K`, and one new `V` — then read the entire accumulated cache of prior `K` and `V` vectors to do the attention maths. The cache grows by one entry per step. It is never rebuilt.

> The KV cache is not an optimisation. It is the direct consequence of which terms in the attention formula are position-invariant and which are not.

If you want the full derivation with a worked example — embeddings, weight matrices, softmax, two-dimensional numbers you can verify by hand, the works — I wrote it up separately in [How Transformer Attention Actually Works](/blog/how-transformer-attention-works/). You don't need it to follow the rest of this post. You only need these three things:

- **Every request has its own KV cache.** It is a per-request, per-layer, per-head data structure that grows by one entry every time the model generates a token. A 70-billion-parameter model in fp16 accumulates roughly **160 KB of cache per token**. A 4,000-token response is 640 MB of ephemeral state. A batch of 50 concurrent requests at 4,000 tokens each is 32 GB — a large fraction of what a datacenter GPU (A100, H100) has available after the model weights.
- **The cache lives in GPU VRAM.** Not disk, not CPU, not any tier you could fail over to cheaply. It is tied to a specific GPU in a specific rack, and the instant the request ends (successfully, failed, evicted — doesn't matter) the memory is reused for something else. There is no "log" of what was in it.
- **LLM inference is memory-bandwidth-bound, not compute-bound.** Every step has to stream the entire KV cache through the GPU's compute units to do the attention maths. The bottleneck isn't "how fast can the GPU do matmul" — it's "how fast can the GPU read the KV cache from HBM." This is why serving an LLM looks nothing like training one: training is compute-bound with GPUs humming at 90%+ utilisation, inference is bandwidth-bound with the compute units mostly waiting for data.

There's one more piece of terminology worth pinning down before we get to vLLM: the distinction between **prefill** and **decode**. Prefill is what happens when the model first sees your prompt — it processes every prompt token in parallel, computes `Q`, `K`, `V` for all of them at once, builds up the initial KV cache, and produces the scores for the first output token. Prefill is compute-heavy and its cost grows roughly quadratically with prompt length. Decode is everything after that — one new token at a time, three new vectors appended to the cache, one attention read over the growing cache, one output. Decode is linear in the current sequence length and spends most of its time reading the cache out of memory rather than doing maths on it. These two phases have such different performance characteristics that modern inference servers schedule them separately.

## vLLM Didn't Optimise Inference. It Made It Possible.

The naive way to manage the KV cache is to allocate one contiguous block per request, sized for the worst-case sequence length. If your max context is 8,000 tokens and you have 10 concurrent requests, you pre-allocate 10 × 8,000 slots of KV cache up front.

This is wasteful in exactly the way you'd expect. Most requests don't use their full context window. A chat message generating a 200-token response occupies slot 0–200 of its block and leaves the remaining 7,800 slots empty and reserved. At scale, this internal fragmentation can eat 60–80% of your KV cache memory. And because memory is the limiting factor for batch size, and batch size is what gives you the bandwidth efficiency that makes inference economically viable, this fragmentation directly translates into lower throughput and higher cost per token.

[**vLLM**](https://github.com/vllm-project/vllm) — the open-source inference server from UC Berkeley that has become the de facto standard for self-hosted LLM serving — solved this with **PagedAttention**. The idea, borrowed directly from virtual memory in operating systems, is to stop treating the KV cache as a contiguous per-request block and start treating it as a pool of fixed-size **pages** (typically 16 or 32 tokens per page).

Each request gets a page table that maps logical token positions into physical pages scattered wherever there's free memory. As a request generates tokens, it allocates pages on demand. As requests finish, pages return to the free pool. The attention kernel is rewritten to follow the page table instead of assuming contiguous memory, and suddenly the internal fragmentation goes away almost entirely.

PagedAttention isn't just an optimisation. It enabled a second thing, which is what actually made modern LLM serving tractable: **continuous batching** (also called iteration-level scheduling). In the old world, a batch of requests started together and finished together — if one request wanted 100 tokens and another wanted 2,000, the short request held its slot idle for 1,900 extra token generations while waiting for the batch to complete. Continuous batching lets requests enter and exit the batch *between forward passes*. As soon as a request finishes, its pages are freed and a queued request can grab a slot on the very next step. GPU utilisation goes up. Tail latency goes down.

The combination — PagedAttention plus continuous batching — is the reason you can run a 70B-parameter model on a single H100 and serve dozens of concurrent streams with acceptable latency. Without it, you're either fragmenting your cache into uselessness or holding slots open for the slowest request in every batch.

What you're calling when you hit `api.openai.com/v1/messages` or a self-hosted vLLM endpoint is not a stateless HTTP service. It is **a multi-tenant scheduler running on top of a bandwidth-bound GPU, sharing the cache across many concurrent generations, evolving page tables between every forward pass.**

![Inside an LLM API call: the client request goes through a scheduler into a GPU worker, where a prefill pass builds the KV cache from the prompt, then a decode loop emits one token per forward pass. The KV cache grows in GPU VRAM with every token generated. Streamed output flows back to the client as each token is produced.](/images/blog/llm-inference-shape.svg)

## That Discount on Your Bill Is the KV Cache

If you've been watching LLM provider pricing lately, you've probably seen a new line item on your bills: **cached input tokens, billed at a fraction of the normal rate**. Anthropic, OpenAI, Google Gemini, and DeepSeek all offer some version of it. The discounts are not small — Anthropic's cache reads are around 90% cheaper than uncached input, OpenAI's are 50% off.

This isn't a marketing gimmick. The "cache" being discounted is literally the KV cache from the previous section, and the discount is the provider passing back the savings from skipping the prefill pass for a prefix that's still resident on their GPUs.

The mechanism is exactly what you'd expect. When a new request arrives, the server hashes the prefix of the prompt and looks it up against the KV cache tensors built by recent requests. If a match is still resident in VRAM (or fast-reloadable from CPU/NVMe), the prefill for that portion is skipped entirely — the K and V vectors already exist. Only the *new* part of the prompt, typically the latest turn in a multi-turn conversation, runs through a fresh forward pass.

The shapes vary by provider:

- **Anthropic** lets you place explicit `cache_control: { "type": "ephemeral" }` markers in your messages. Cached reads are roughly 90% off, writes carry a ~25% premium on first use, and the default TTL is 5 minutes (a 1-hour option exists for a bigger write premium). Minimum cacheable block is ~1,024 tokens; you can place up to 4 breakpoints in a single request.
- **OpenAI** does it automatically. No API changes — the server hashes incoming requests and routes matching prefixes to the same backend to maximise hit rate. Cached input tokens are billed at 50% of the uncached rate, and typical retention is 5–10 minutes under load.
- **Google Gemini** exposes caching as an explicit `CachedContent` resource with a configurable TTL. You pay a per-hour storage cost and get a meaningful discount on reads in return — it's aimed squarely at long-lived shared contexts like document corpora or large codebases.
- **DeepSeek** runs an automatic disk-backed KV cache and charges one of the most aggressive cached-read rates of any provider.
- **Self-hosted stacks** get the same mechanism for free: vLLM has automatic prefix caching, and [SGLang's RadixAttention](https://arxiv.org/abs/2312.07104) maintains a radix tree of KV cache prefixes so that many requests can share branches even when their conversations diverge further along.

Where this pays off is exactly the obvious case: **multi-turn conversations**. The first message pays full prefill cost. Every subsequent message is `system prompt + message 1 + response 1 + message 2 + ...` — a growing prefix whose first N tokens are identical to the previous request. Without caching, the server re-prefills the entire history on every turn, which is where a lot of the surprising latency and cost in long chat sessions comes from. With caching, it skips the expensive part and only prefills the new tokens.

Three things about this matter for the retry discussion coming up next:

- **The cache is best-effort.** If the provider is under load or you've paused past the TTL, your entry evicts and you pay full price again. You can't depend on it; you can only benefit when it hits.
- **Cache hits are deterministic for the cached portion.** The K and V tensors are a pure function of token IDs and model weights, so providers can safely share entries across tenants — there's no semantic leakage, because the cached bits are the same regardless of who hit first.
- **It doesn't help with retry.** Prefix caching matches *content*, not request IDs. A failed request doesn't leave a resume token; it leaves a cache entry your retry might *incidentally* hit on its prefix — but the portion *after* the cache boundary runs fresh, with fresh sampling. Prompt caching is "skip the prefill you've already paid for." It is not "resume the generation you were halfway through."

## There Is No "Resume"

If prompt caching could save a retry, we'd be done. It can't — and understanding why is where the simplest retry strategy in the world, *"if the request fails, try it again,"* goes from uncomfortable to impossible.

I've been the person who shipped the naive retry on a streaming LLM call. It's not a fun postmortem. The system emits partial answers. Then it emits different partial answers. Users complain that the chatbot is contradicting itself mid-sentence. You look at your logs and you can see the first stream died, you can see the retry succeeded, and you cannot for the life of you explain why the two halves of the conversation disagree about what month it is.

Consider what "retry mid-stream" would actually need to do. Your client has received 200 tokens. The upstream HTTP/2 connection drops. You'd like to resume the stream and get the remaining tokens.

Here's what you'd need to reconstruct on the server side:

1. **The KV cache for the prompt plus the 200 tokens already emitted.** This is the part that's gone. The instant the stream died, the scheduler freed the request's pages. Another request probably grabbed them within the next forward pass.
2. **The exact sampling state** — the random seed, the sampler configuration, anything that influenced which of the ~40,000 possible next tokens got chosen at each position.
3. **The exact batch composition** for every forward pass that produced those 200 tokens, because the numerics of GPU reductions depend subtly on what else was in the batch.

![Two timelines contrasting the mental model of retry — "pick up where it left off" — with what actually has to happen. In reality, the KV cache is freed when the stream dies, and attempt two has to run a full prefill pass over the prompt plus all already-emitted tokens before it can generate a single new one. Three cost callouts: recomputation cost, non-determinism from sampling and batch composition, and no cross-replica fail-over because the KV cache lives in one GPU's VRAM.](/images/blog/llm-retry-cost.svg)

The first one alone kills the idea. Rebuilding the KV cache means re-running the prompt plus all 200 emitted tokens through the model from scratch — a full prefill pass. That's not just expensive, it's *the expensive part* of LLM inference. Prefill is why first-token latency is often higher than inter-token latency by 10×. You are not resuming; you are re-doing most of the work.

But even if you pay the cost and rebuild the cache, the second and third problems guarantee you won't produce the same completion. Temperature-based sampling is inherently random. Even greedy decoding isn't quite deterministic across runs, because GPU reductions over floating-point values are non-associative and parallel reductions can produce slightly different results depending on thread scheduling. Production inference engines routinely explicitly disable determinism guarantees in the name of throughput. Even with a fixed seed, **batch composition affects the numerics** — if request A was batched with {B, C, D} last time and {E, F} this time, the floating-point outputs can differ by a few ULPs, the sampler can tip over to a different token at some decision boundary, and the completions diverge.

> "Resume" isn't hard. It's physically impossible without rebuilding the cache from scratch — and rebuilding the cache is the expensive part of the entire computation.

So "resume" is a fantasy. You cannot pick up where the stream left off. The best you can do is one of three things:

- **Retry only before any tokens have been forwarded to the caller** (the "pre-first-chunk window"). Safe, because the caller never saw the aborted attempt. Cheap, because no KV cache existed yet on the client side to reconcile. This is the default we [shipped in PromptKit last week](/blog/streaming-llm-back-pressure/) and it catches a surprising number of real failures — mostly h2 connection resets during the initial prefill.
- **Retry the whole request from scratch and tell the consumer to throw away what it had**. This is the "mid-stream reset" approach. You emit a Reset signal, the downstream pipeline clears its accumulated state, and you run the full request again — burning extra tokens for a fresh, likely-different completion. Off by default everywhere sensible, because those extra tokens aren't free, but strictly better than an unrecoverable error when the caller would rather have *an* answer than *no* answer.
- **Fail the request.** Honestly the right answer a lot of the time. If your application can fall back gracefully — cached response, simpler model, "I can't help with that right now" — failing fast is cheaper than retry games.

There is no fourth option where the GPU hands the in-flight KV cache to another node and picks up where it left off. That node doesn't have the cache, the pages have been recycled, and even if you could reconstitute everything bit-for-bit (you can't), you'd still have to pay the prefill cost and still end up with a different completion.

## Everything Weird About LLM Infrastructure Follows From This

Once you see the shape of the thing — a real-time, stateful, memory-bandwidth-bound computation running on a specific GPU with an ephemeral cache — a lot of the weirdness of LLM infrastructure stops being weird:

- **Latency is two numbers, not one** (time to first token, and time between tokens) because the prefill pass and the decode loop are two different regimes with different bottlenecks.
- **Retries are dangerous** because the "idempotent" assumption that works for REST calls does not hold for a stateful, non-deterministic process.
- **Observability is hard** because the interesting metrics — tokens per second, KV cache utilisation, batch occupancy, queue depth at the scheduler — look nothing like the HTTP histograms you're used to.
- **Fail-over is hard** because the KV cache is tied to a specific GPU and can't be cheaply migrated.
- **Autoscaling signals look weird** because GPU utilisation is a terrible signal (it's pegged at 100% as long as anything is in the batch) and the real signal is queue depth plus time-to-first-token.
- **Cost accounting is hard** because a single request can occupy a slot for minutes and its marginal cost depends on what else was in the batch alongside it.

None of this is accidental complexity. It all falls out of the physics: **text is generated one token at a time, each token needs the cache of every prior token, the cache is too big to move, and the math is non-deterministic.**

## Stop Fighting the Shape

LLMs don't return responses. They *produce* them, in real time, on a specific GPU, with a cache that exists only for the life of the request and cannot be recreated. Every piece of infrastructure that sits in front of an LLM — gateways, schedulers, retry logic, batching layers, autoscalers — has to make peace with that or fight it and lose.

Most of what I see in the wild is fighting it. Teams treat LLM calls like REST calls because REST is the shape the HTTP layer presents, and then they're surprised when the thing underneath behaves like nothing they've ever operated. They retry blindly. They measure the wrong latency number. They scale on GPU utilisation. They assume cached prefixes mean "safe to resume." They try to migrate state that can't be migrated. And they burn a lot of engineering hours learning, one postmortem at a time, that the abstraction was lying to them.

The frameworks that stay up at 2,000 concurrent are the ones that gave up the illusion early. [Bounded retry windows. Careful back-pressure. No pretending about resumption.](/blog/streaming-llm-back-pressure/) Metrics that look like what's actually happening on the GPU, not what the HTTP library reports. It's not more complicated than the REST mental model — it's just honest about the thing it's talking to.

Once you see the shape of the thing, a lot of the weirdness stops being weird. It starts being inevitable. And inevitable is much easier to design around than mysterious.
