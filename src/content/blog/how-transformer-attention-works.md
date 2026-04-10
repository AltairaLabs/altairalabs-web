---
title: "How Transformer Attention Actually Works: A Worked Example"
description: "Attention, embeddings, Q/K/V, softmax — walked through by hand with two-dimensional numbers a platform engineer can verify on the back of an envelope. No machine-learning background required."
date: 2026-03-13
tags: ["llms", "gpu", "inference", "machine-learning"]
author: "Charlie Holland"
draft: false
---

## The Machinery Is Simpler Than It Looks

There's a persistent myth in software engineering that LLMs are too complicated to understand without a machine learning background. It's wrong. The machinery that actually produces text is a two-line formula and a loop — you can walk through it on the back of an envelope in about fifteen minutes. What takes longer is sitting with the result and accepting that *that's really all there is*, because a surprising amount of operational strangeness in LLM infrastructure — streaming, prompt caching, the impossibility of resuming a mid-stream failure, autoscaling signals that lie — stops being strange once you can see the formula.

This post is the walkthrough. No machine learning background required. I'm going to assume you know:

- A token is roughly a word or a word-fragment
- Models have "weights" they learned during training
- GPUs are fast at matrix multiplication

That's it. No prior exposure to transformers, no PyTorch, no ML course. By the end of this post you'll know what attention is, what the Q/K/V vectors actually are (and aren't), why the KV cache has to exist, and how it all drops out of a handful of dot products.

Consider this the prerequisite for [What Actually Happens When You Call an LLM API](/blog/what-actually-happens-when-you-call-an-llm/) — where I use this machinery to explain why streaming, retries, prompt caching, and scaling an LLM look nothing like any other web service you've ever operated.

## Attention, in Plain English

Inside every layer of a transformer model, there's an operation called **attention**. Despite the somewhat precious name, what it does is simple: it lets each position in the sequence *look back* at every previous position and combine information from them. When the model is trying to predict the next token after "the cat sat on the", that new position looks back at "the", "cat", "sat", "on", "the" — and assigns each of them a weight based on how relevant it thinks they are. The output is a weighted mixture of information drawn from all five prior tokens.

Attention works by computing three vectors for every token in the sequence: a **query** (Q), a **key** (K), and a **value** (V). The mental model is:

- **Q** is "what am I looking for?" — computed for the position currently being generated.
- **K** is "what am I?" — an identity tag for each token in the sequence.
- **V** is "what do I contribute if someone looks at me?" — the payload each token carries.

## How the Metaphor Becomes Numbers

Every token arrives at this layer as an **embedding** — a vector of a few thousand numbers (typically 4,096 or 8,192 in a modern model) that the model learned during training. You can think of the embedding table as a huge lookup: one dense vector per token in the vocabulary. No single number in an embedding cleanly encodes a concept like "noun" or "related to cats" — the meaning is *distributed* across the whole vector. What matters is the aggregate geometry: tokens the model thinks are similar end up with embeddings pointing in similar *directions*, and unrelated tokens point in different directions.

![Token embeddings visualised as vectors in two-dimensional space. Three "animal" words — cat, dog, fish — cluster into vectors pointing in the same general direction. Three "verb" words — sat, run, walk — cluster in a different direction. Three "colour" words — red, blue, green — cluster in a third direction. Similar tokens end up pointing the same way.](/images/blog/attention-embeddings-directions.svg)

Real embeddings live in thousands of dimensions, not two. The sketch above is the sort of picture you'd get by projecting that high-dimensional space down onto a plane — the clustering is real, but there is no single "animal axis" or "verb axis" inside the actual vectors. You can't point at position 17 and say "that's the one that means animal." The direction you see in 2D is the emergent result of thousands of numbers all pulling their own small weight.

Q, K, and V are derived from that embedding by multiplying it by three separate **weight matrices** — one for each role — that the model learned during training. Each multiplication produces another vector, usually shorter than the embedding (64 to 256 numbers per head is typical). That's all Q, K, and V are: three different learned projections of the same underlying token embedding.

One subtlety worth nailing down: multiplying a vector by a weight matrix isn't element-wise scaling. Every number in the output is a weighted sum of *every* number in the input, blended in learned proportions. Imagine the embedding is a fruit salad and each weight matrix is a recipe for turning that salad into a smoothie. The "query smoothie" isn't made by scooping out "the query parts" — it's made by blending every fruit in the bowl according to its own learned recipe.

![The same token embedding — visualised as a bowl of mixed fruit — feeds into three separate learned weight matrices W_Q, W_K, W_V, producing three different output vectors: a query vector Q, a key vector K, and a value vector V. Each output is a blend of all the input numbers, not a selection of them. Three recipes, three different vectors, from one salad.](/images/blog/attention-qkv-projection.svg)

And there isn't just one `W_Q` in a real model. Every layer has *dozens* of attention heads, each with its own independent `W_Q`, `W_K`, `W_V`. Each head learns to specialise during training — one might end up tracking coreference, another syntactic structure, another topic consistency. Nobody tells them what to track. They discover it.

"This token's Q matches that token's K" means one thing: **the dot product of those two vectors is a big number**. Dot product is a geometric similarity measure — large when two vectors point in similar directions, small or negative when they don't.

![Three panels showing how the dot product of two vectors behaves geometrically. In the first panel, two vectors point in nearly the same direction and the dot product is a big positive number labelled "match". In the second panel the vectors are perpendicular and the dot product is about zero, labelled "unrelated". In the third panel the vectors point in opposite directions and the dot product is negative, labelled "mismatch". Softmax turns these dot products into the weights the model uses to decide which prior tokens to look at.](/images/blog/attention-dot-product-similarity.svg)

Training adjusts the weight matrices so that the pairs of tokens the model *wants* to match (a verb and its relevant subject, a pronoun and its antecedent, a question and its answer) end up with Q and K vectors pointing the same way after projection. That's the whole trick: the "meaning" of a match is learned geometrically, not symbolically.

Tokens have **positions** — just indices into the sequence. Position 0 is the first token, position 1 the second, and so on. Call the position the model is currently working on `t` — everything before `t` has already been generated, and `t` is the one being computed right now.

To produce the output for position `t`, the model dot-products that position's `Q` against every prior position's `K` (big dot product = high relevance), turns the resulting scores into weights with a function called **softmax** (which normalises a list of numbers into probabilities that sum to 1), and uses those weights to mix together the prior `V` vectors. The whole thing boils down to one line:

```
Attention(Q, K, V) = softmax( Q · K^T / √d_k ) · V
```

(The `/ √d_k` is a numerical stability trick for large dimensions — you can ignore it for intuition.)

That formula is dense, but it's three steps stacked into one line. Read it left to right.

**`Q · K^T` — the matching scores.** Your `Q` is "what am I looking for." Each prior token's `K` is "what am I." Dot-product your Q against every prior K and you get one number per prior token: a match score. Big number = this token looks like what you're looking for. Small or negative = it doesn't.

**`softmax(...)` — from scores to weights.** Softmax normalises that list of scores into weights that sum to 1. A high score becomes a big weight ("give this token most of your attention"); a low score becomes a near-zero weight ("effectively ignore it"). This is where *"if the match is low, the token is irrelevant"* literally happens — the maths drives the irrelevant tokens' weights to nearly zero.

**`... · V` — mixing in the payloads.** The subtle one. `V` is *not* a knob for "how much does this match matter" — that knob is the softmax weight, from the previous step. `V` is *what the matched token has to say*, the payload it contributes if the model decides to listen. Every prior token's `V` gets scaled by its softmax weight and summed into one output vector. Tokens that matched well dominate the sum; tokens that didn't contribute almost nothing — not because their `V` is small, but because the weight scaling it is.

An analogy for that last step: imagine you're in a conference room with a dozen speakers and you have a question. `Q` is your question. Each speaker's `K` is what they're an expert in. `Q · K` is how well your question matches each speaker. `softmax(...)` turns those scores into how much airtime each speaker gets, as fractions that sum to 100%. `V` is what each speaker actually says. The output is the blended message you end up with after giving each speaker their fraction of airtime. `V` is *what the speaker says*, not *how important the speaker is* — importance is decided one step earlier.

## Where Q, K, and V Come From

The rest of the post uses a tiny bit of notation, so let's nail it down. If `x_i` is the embedding of the token at position `i`, and `W_Q`, `W_K`, `W_V` are the three learned weight matrices for this layer:

```
Q_i = x_i · W_Q     ← the query vector for the token at position i
K_i = x_i · W_K     ← the key vector for the token at position i
V_i = x_i · W_V     ← the value vector for the token at position i
```

Three multiplies, three small vectors. Notice what depends on what: `Q_i`, `K_i`, and `V_i` each depend on exactly two things — the embedding of the token at position `i` and a weight matrix frozen at training time. Nothing about position `i`'s Q/K/V pays any attention to what's happening anywhere else in the sequence. Each token's Q, K, V are computed in isolation, from the token itself.

That independence is the hinge the KV cache swings on. When the model generates a new token at position `t`, the attention output for that position works out to:

```
scores_t = softmax( [Q_t · K_0^T , Q_t · K_1^T , ... , Q_t · K_t^T] / √d_k )

output_t = Σ  scores_t[i] · V_i         for i = 0..t
```

Three things drop out of these equations, and they are the whole story of LLM serving infrastructure.

**First:** the output at position `t` needs `K_i` and `V_i` for *every* prior position. Attention means "this token looks at all the previous tokens" — run naively, every new token would recompute `K` and `V` for every prior token from scratch.

**Second:** you don't have to recompute them. `K_i` and `V_i` for a given token never change across steps — they depend only on that one token and the frozen weights. Compute them once, cache them forever.

**Third:** the query is the odd one out. `Q_t` changes every step because `t` changes every step. You always want the query for the *current* position and you throw it away as soon as the attention output is computed. Q is not cached.

> The KV cache is not an optimisation. It is the direct consequence of which terms in the attention formula are position-invariant and which are not.

## A Worked Example

Let's do this with numbers small enough to verify in your head. Two-dimensional everything: `d = 2`. One attention head. A three-token prompt. Made-up embeddings and made-up weight matrices, chosen for easy arithmetic rather than realism.

**Setup.** The prompt tokens, represented as tiny 2-dimensional embeddings:

```
x_0 = [1, 0]     ← "the"
x_1 = [0, 1]     ← "cat"
x_2 = [1, 1]     ← "sat"
```

And three fixed 2×2 weight matrices for this layer, which the model learned during training:

```
W_Q = [[1, 0],        W_K = [[0, 1],        W_V = [[1,  1],
       [0, 1]]               [1, 0]]               [1, -1]]
```

**Prefill pass.** The model processes the whole prompt in one go, computing `Q`, `K`, `V` for every position. Each one is a vector-matrix multiply:

```
Q_0 = x_0 · W_Q = [1, 0]       K_0 = x_0 · W_K = [0, 1]       V_0 = x_0 · W_V = [1,  1]
Q_1 = x_1 · W_Q = [0, 1]       K_1 = x_1 · W_K = [1, 0]       V_1 = x_1 · W_V = [1, -1]
Q_2 = x_2 · W_Q = [1, 1]       K_2 = x_2 · W_K = [1, 1]       V_2 = x_2 · W_V = [2,  0]
```

Nine vector-matrix multiplies. Three new K vectors and three new V vectors get written into the KV cache. Now the model can compute attention for position 2 — the last prompt token — to get the scores it'll use to pick the first output token:

```
Q_2 · K_0 = 1·0 + 1·1 = 1
Q_2 · K_1 = 1·1 + 1·0 = 1
Q_2 · K_2 = 1·1 + 1·1 = 2

scaled      = [1, 1, 2] / √2  ≈  [0.707, 0.707, 1.414]
softmax     ≈ [0.248, 0.248, 0.503]   ← weights sum to 1

output_2 = 0.248 · [1, 1] + 0.248 · [1, -1] + 0.503 · [2, 0]
         ≈ [1.503, 0.000]
```

Position 2's output is a weighted mix of `V_0`, `V_1`, `V_2`, with the weights coming from how similar `Q_2` is to each prior `K`. That's attention — position 2 looking at all three prior positions, weighted by relevance.

`output_2` then feeds into the rest of the model (we'll get to that in a moment). At the end of that pipeline, the model picks a new token. Say its embedding turns out to be:

```
x_3 = [0.5, 0.5]   ← the sampled next token
```

**Next token (decode step).** Here is the critical bit. Naively, generating this next token would mean recomputing `Q`, `K`, `V` for every position from 0 to 3 — twelve vector-matrix multiplies in total. But `K_0`, `K_1`, `K_2` and `V_0`, `V_1`, `V_2` are already in the cache from the prefill pass and *they haven't changed*. The model only needs to compute the three new vectors for the new token:

```
Q_3 = x_3 · W_Q = [0.5, 0.5]     ← computed fresh (Q is never cached)
K_3 = x_3 · W_K = [0.5, 0.5]     ← computed once, appended to cache
V_3 = x_3 · W_V = [1.0, 0.0]     ← computed once, appended to cache
```

Three multiplies instead of twelve. Nine of them were saved by reading from the cache. Now the attention at position 3:

```
Q_3 · K_0 = 0.5·0 + 0.5·1 = 0.5
Q_3 · K_1 = 0.5·1 + 0.5·0 = 0.5
Q_3 · K_2 = 0.5·1 + 0.5·1 = 1.0
Q_3 · K_3 = 0.5·0.5 + 0.5·0.5 = 0.5

scaled      = [0.5, 0.5, 1.0, 0.5] / √2  ≈  [0.354, 0.354, 0.707, 0.354]
softmax     ≈ [0.226, 0.226, 0.322, 0.226]

output_3 = 0.226·[1, 1] + 0.226·[1, -1] + 0.322·[2, 0] + 0.226·[1, 0]
         ≈ [1.322, 0.000]
```

Every subsequent token does the same thing: one new `Q`, one new `K`, one new `V`, append to the cache, do the attention read over the whole cache, produce one output vector. The cache grows by one `K` and one `V` per step. The attention *read* gets slightly more expensive each step, but you never pay the cost of recomputing everything from scratch.

## From a Vector to a Token

`output_2` is a *vector*, not a token. `[1.503, 0.000]` isn't a word. So how does a pile of vectors actually turn into the next token the model emits?

More layers, and one final trick. Each transformer layer doesn't just do attention — it also runs a small feedforward network afterwards (a couple more matrix multiplies) to produce a new per-position vector. That vector feeds into the next layer's attention. The attention → feedforward pattern repeats 32, 80, or 120 times depending on the model, each layer refining the representation a bit further.

At the top of the stack, the output at the current position is one last vector — the same shape as the original input embedding. That final vector gets multiplied by one more learned matrix, often called the **LM head**, which produces one score for every token in the vocabulary. A 4,096-number vector times a 4,096 × 50,000 matrix gives you 50,000 numbers, one per possible next token. Those scores are the **logits**.

Softmax over the logits turns them into a probability distribution: *"83% chance the next token is `cat`, 7% chance it's `dog`..."* and so on. The sampling step — greedy, temperature, top-k, top-p — picks exactly one token from that distribution. That token is the next token. Its embedding gets looked up, fed back in, and the loop runs again.

The full path, end to end: embedding lookup → (attention → feedforward) × 80 layers → LM head → logits → softmax → sample → token. Attention is one crucial step in that pipeline — the only step that mixes information *across* positions — but the vector it produces at any given layer is an intermediate representation, not the answer.

## Now Scale This Up

Real models have 80 layers, 64 attention heads per layer, `d_k` somewhere between 64 and 256, and sequences thousands of tokens long. The shape of the computation is identical to the toy example above: every new token computes three small new vectors, reads a big pile of cached ones, and produces one output. Only the dimensions change.

The distinction between **prefill** and **decode** drops out of this naturally. Prefill is what the model does when it first sees the prompt: it computes `Q`, `K`, `V` for every prompt token in parallel, does the attention maths for every position at once, and produces the scores for the first output token. Prefill is compute-heavy and grows roughly quadratically with prompt length. Decode is everything after: one token at a time, three new vectors, one attention read over the growing cache, one output. Decode is linear in sequence length and spends most of its time *reading* the cache rather than doing maths on it.

At production scale, the KV cache numbers get real. A 70-billion-parameter model with 80 layers and 64 attention heads, running in fp16, accumulates roughly **160 KB of cache per token**. A single 4,000-token response is 640 MB of ephemeral state. A batch of 50 concurrent requests at 4,000 tokens each is 32 GB — more than most consumer GPUs have in total, and a large fraction of what a datacenter GPU has available after the model weights.

Three things follow:

- **The KV cache lives in GPU VRAM.** Tied to a specific GPU, not cheaply migratable.
- **It is ephemeral.** When a request finishes or fails, the cache is freed and its memory is reused immediately.
- **Inference is memory-bandwidth-bound.** The bottleneck is reading the cache out of HBM fast enough, not doing matmul on it.

## Why This Matters in Practice

The worked example is tiny, but the shape of what it shows is identical to what happens inside a 70B-parameter model running at OpenAI or Anthropic or your self-hosted vLLM cluster right now. Every token of every LLM API response you have ever received came out of a loop that looks exactly like this, just with bigger matrices.

And once you can see where the state actually lives — per-request, in the VRAM of one specific GPU, ephemeral, impossible to migrate cheaply — a lot of the things that seem weird about LLM infrastructure stop being weird. Streaming is the only sensible way to return data that's still being computed. Retries are dangerous because the cache dies with the request. vLLM's PagedAttention is clever because it treats the cache like virtual memory. Autoscaling on GPU utilisation is a terrible signal because utilisation is pegged at 100% the moment anything is in the batch.

The follow-up — [What Actually Happens When You Call an LLM API](/blog/what-actually-happens-when-you-call-an-llm/) — takes the machinery built up here and uses it to explain why streaming, retries, prompt caching, and scaling an LLM look nothing like any other web service. This is the post you read first.
