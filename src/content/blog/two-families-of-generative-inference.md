---
title: "The Two Families of Generative Inference: Autoregressive and Iterative Refinement"
description: "Every generative model in production today belongs to one of two architectural families. Text and music went autoregressive. Images and video went diffusion. Speech is a mess split across both. Here's how the two shapes differ, and why the choice settles almost every interesting operational question about the infrastructure underneath."
date: 2026-04-14
tags: ["generative-ai", "inference", "gpu", "diffusion", "llms"]
author: "Charlie Holland"
draft: false
---

## Two Shapes, Not One

If you use both Claude and Midjourney, you've seen something strange. Claude's response appears word by word, streaming out in real time like someone typing on the other end. Midjourney's image shows up all at once as a blurry mess and then refines, over five or six seconds, into something coherent. Same kind of GPU on the other end, same "AI," but the user experience is completely different — and it's completely different because the *computation* is completely different.

There are really only two shapes of generative inference. Every production model you care about — text, images, audio, video — fits into one of two architectural families, and almost every interesting operational question about these systems (streaming, retry, batching, latency, cost) is settled the moment you know which family a model belongs to.

The two families are **autoregressive** generation and **iterative refinement**. Text LLMs are autoregressive. Image generators are (almost all) iterative refinement. Music generators are autoregressive. Video generators are iterative refinement. Speech is a mess split across both. By the end of this post, you'll know why each modality ended up where it did, and why "runs on a GPU" is an almost useless abstraction for reasoning about any of it.

## Family 1: Autoregressive — One Piece at a Time

The autoregressive family produces its output one piece at a time, with each new piece conditioned on every piece before it. For a text LLM that "piece" is a token (roughly a word or word-fragment). For MusicGen that "piece" is an audio codec token — a compressed representation of a short slice of sound. For an older image model like DALL-E 1 or Google's Parti it was an image patch token. But the shape of the computation is identical in all cases:

1. Look at everything generated so far.
2. Run it through the whole model to produce a score for every possible next piece.
3. Sample one piece.
4. Append it to the sequence.
5. Go back to step 1, until you hit a stopping condition.

I wrote the full walkthrough of this loop, including the maths of why the state during generation (the KV cache) grows monotonically with output length, in [How Transformer Attention Actually Works](/blog/how-transformer-attention-works/). The short version is: every new piece adds one entry to the cache, and the cache for every prior piece is fixed the moment that piece was generated. Autoregressive inference is fundamentally *sequential*. You cannot produce piece 5 without first having piece 4. The GPU spends most of its time streaming the growing cache out of HBM to compute the next step.

Three properties of this family matter for infrastructure:

- **Output is produced incrementally, in order.** This makes streaming free — you emit each piece as soon as you have it.
- **Cost scales with output length.** A 100-piece response is roughly ten times the work of a 10-piece response, and you don't know the total cost of a request until it's done.
- **The state dies when the request dies.** The KV cache lives in VRAM for the life of the request, growing as you go. Once the request ends, the cache is freed and you can't rebuild it cheaply — and even if you did, sampling non-determinism means you'd get a different answer.

Modalities that landed in this family: **text** (GPT, Claude, Gemini, Llama), **music** (MusicGen, AudioLM, Jukebox), **some speech** (Bark, Tortoise), and **some older image models** (DALL-E 1, Parti).

## Family 2: Iterative Refinement — All At Once, Many Times

The iterative refinement family produces its output in a completely different shape. Instead of generating one piece at a time, the model holds a fixed-size block of numbers shaped like the image it's going to produce — and starts those numbers off as pure random noise, the numerical equivalent of television static. A neural network looks at that noisy block and predicts *what to subtract from it to make it slightly less noisy and slightly more like a real image*. Subtract. The block is a bit cleaner. Feed it back through the same network. Predict noise. Subtract. Repeat, typically twenty to fifty times (though that count is falling fast with newer sampling techniques). By the end, there's no noise left and the block is a coherent image.

(In practice, production models like Stable Diffusion don't work on the final image's pixels directly. They work on a smaller, compressed numerical representation — often called a *latent* — and only unpack it into real pixels at the very end, with a separate small network. This is purely a speed optimisation: the block of numbers being refined is smaller than the final image, so each step is cheaper. It doesn't change the shape of the computation. For the purposes of this post you can mostly ignore the distinction and think of the block as "the image, in numerical form.")

Midjourney, Imagen, Flux, SDXL, DALL-E 3, and the image generators inside ChatGPT all do some version of this. SORA, Veo, Runway, and every other production video model do the same thing at video scale — the block of numbers is now shaped like a stack of frames instead of a single image, but it's still refined in the same step-by-step way.

The key observation: **at every step, the network looks at and modifies the entire block**. There is no "first pixel" or "first frame." All the pixels in the image (or all the frames in the video) are refined at the same time, at every step. The only sequence involved is the sequence of refinement steps — which is a completely different kind of sequence from the piece-by-piece output of an autoregressive model.

Three properties of this family matter for infrastructure:

- **Output is built up globally, not incrementally.** You cannot meaningfully show partial results until the denoising has progressed far enough that the image is recognisable. "Streaming" in a diffusion model means showing intermediate denoising steps — which is a product choice, not a natural consequence of the computation.
- **Cost is fixed per request.** Twenty-five denoising steps is twenty-five forward passes of the network. It doesn't matter whether the prompt was "a cat" or "a photorealistic corgi in a spacesuit holding a latte on the surface of Mars, cinematic lighting, eight-k resolution" — the compute is the same.
- **Mid-generation state is a fixed-size latent.** There's no KV cache, no growing data structure. The state is the same size at step 5 as it is at step 50 — just progressively less noisy.

Modalities that landed in this family: **images** (Stable Diffusion, SDXL, Flux, Midjourney, Imagen, DALL-E 3), **video** (SORA, Veo, Runway Gen-3, Kling), and **some speech** (StyleTTS 2, a handful of diffusion-based TTS systems).

![Side-by-side comparison of state evolution. In the autoregressive column, each step adds one entry to a growing KV cache — the cache is longer at every step. In the iterative refinement column, the state is a fixed-size latent that stays the same size at every step but becomes progressively less noisy. Same GPU, two completely different shapes of computation.](/images/blog/generative-inference-two-shapes.svg)

## What Actually Happens at Each Step

The diagram above treats each step as a single atomic operation. In production, a single step is considerably more involved than "one forward pass of the denoising network," and the operational story has its own share of the hidden complexity I went into for LLMs in [What Actually Happens When You Call an LLM API](/blog/what-actually-happens-when-you-call-an-llm/). Four things are worth knowing.

![Full pipeline of a production diffusion model. A text prompt flows through one or more large text encoder networks to produce a summary vector. A random seed initialises a noise block the same shape as the output. The denoising loop runs N times — each iteration consists of two forward passes of the denoising network (one with the prompt, one without, for Classifier-Free Guidance), an extrapolation between them, and a subtraction that makes the block slightly cleaner. That cleaner block is fed back in. After N iterations, the clean latent is decoded through a VAE into the final output image.](/images/blog/diffusion-pipeline-blocks.svg)

**Before diffusion even starts, the prompt has to be encoded.** A production diffusion model runs your text prompt through one or more *separate* text encoder networks — T5 and CLIP are the usual suspects — which produce the summary vector the denoising network then conditions on. These text encoders are substantial models in their own right: T5 XXL is 11 billion parameters, and Stable Diffusion 3 uses *three* text encoders running in parallel. This is a one-time cost at the start of every request, but it's not free. A "diffusion model" in production is really two or three models chained together in a pipeline.

**Each step is usually two forward passes of the denoising network, not one.** Production diffusion models use a technique called **Classifier-Free Guidance**, or CFG. At every step, the network runs twice — once with the prompt as conditioning, once *without* — and the model extrapolates between the two outputs to pull the image more strongly toward what the prompt asked for. So "twenty-five steps" in a typical image generation request is actually *fifty* forward passes of a ten-billion-plus-parameter network. That doubling is baked into most published step counts but almost never called out in user-facing documentation.

**Step counts are in free-fall.** Classical diffusion needed fifty to a hundred steps. Modern samplers (DDIM, DPM++ 2M, UniPC) brought that down to twenty or so. The latest round of techniques — consistency models, distilled variants, and "turbo" models like SDXL Turbo, SD3 Turbo, and Flux Schnell — push it down to *one to four steps*. A standard diffusion model and a distilled one have operational profiles so different that they might as well be different product categories: both are doing the same mathematical thing, but one takes fifty forward passes and the other takes two, on the same hardware, with noticeably different output quality trade-offs.

**Retry semantics depend on which sampler you chose.** The promise that "the same seed gives the same image" only holds for **deterministic** samplers — DDIM, DPM++ 2M, UniPC, and friends. **Stochastic** samplers (DDPM, Euler ancestral) inject fresh noise at each step, so the same seed produces a different image on every run. If your operational model assumes "retry from seed is trivial" — the whole inversion of the LLM story that makes diffusion feel easy — you need to know which sampler your production stack is actually using. Not every team does, and the difference only shows up when someone hits retry and gets a different picture back.

None of this is secret. It's the layer of detail that separates "I read the diffusion paper" from "I operate a diffusion model in production," and the infrastructure story ends up less simple than "run the network twenty-five times."

## The Infrastructure Implications

Once you know which family a model belongs to, you immediately know a surprising amount about its operational profile. The comparison that matters:

| Property | Autoregressive | Iterative refinement |
|---|---|---|
| **State during generation** | KV cache, grows per piece | Fixed-size latent, refined over steps |
| **Cost per request** | Variable (depends on output length) | Fixed (depends on step count) |
| **Streaming** | Natural (one piece per forward pass) | Has to be faked (show partial denoising) |
| **Mid-failure retry** | Effectively impossible | Trivial (same seed = same output) |
| **Batching** | Continuous (requests flow through) | Static (batch steps together) |
| **What dominates latency** | Output length × per-token cost | Step count × per-step cost |
| **What dominates total cost** | Context length × output length | Step count × network size |

A few of these rows are worth lingering on, because the inversions are striking.

**Retry is the most surprising one.** Autoregressive models have effectively impossible mid-stream retry — I wrote about this at length in [What Actually Happens When You Call an LLM API](/blog/what-actually-happens-when-you-call-an-llm/). The KV cache is gone the moment the request dies, rebuilding it means replaying the entire prompt plus the already-emitted pieces, and even then sampling non-determinism means you get a different answer than the one the user was mid-sentence reading. Diffusion models have *trivial* retry. The denoising process is deterministic given the starting noise and the sampling schedule; save the seed and you can reproduce the exact same image bit-for-bit. Save an intermediate step and you can resume from there. Failures that are unrecoverable catastrophes for an LLM are "hit retry" for a diffusion model.

**Batching works completely differently.** Autoregressive models use **continuous batching** (iteration-level scheduling) — requests enter and exit the batch mid-generation, because each request is on its own token clock. This is how vLLM keeps GPU utilisation high for text serving. Diffusion models use **static batching** — all the requests in a batch step through denoising together, because every request in the batch is at the same step at the same time. You can't easily drop a finished request out of a batch partway through; you can't easily bring a new request into a batch that's already on step 15 of 25. This has real consequences: a diffusion batch can't accept new requests until the current batch finishes, which means tail latency is dominated by whichever request is slowest in the batch, and scheduling is much less elastic than for an LLM.

**Cost scales completely differently with input size.** An LLM's cost is quadratic in sequence length, thanks to attention — a 1,000-token prompt is roughly a hundred times more expensive to prefill than a 100-token prompt. A diffusion model's cost is roughly independent of prompt length; the prompt gets encoded into a small summary vector once at the start of generation, and that same summary is fed back into the denoising network at every step. This is why image generation prices are usually flat per image regardless of how long your prompt is, and why LLM pricing has tokens as a first-class billing unit. The underlying maths determines the billing model.

## Where Each Modality Landed, and Why

It wasn't arbitrary. Each modality landed in one family or the other because the structure of the data it produces matched one shape of computation better than the other.

**Text is naturally sequential.** Language unfolds one word at a time, and meaning composes left-to-right with strict causal dependencies. You cannot sensibly refine "all the words in the sentence at the same time" because each word's best choice depends on the words before it. Autoregressive is a natural fit, and the training objective (predict the next token) is one of the strongest and simplest training signals in machine learning.

**Music has temporal structure too.** Music is also sequential in time. Modern audio compression models can chop a sound file into a stream of small discrete codes — essentially the audio equivalent of text tokens. Once you have that stream, an autoregressive transformer can predict the next code the same way a text model predicts the next word. It's essentially "text prediction, but the vocabulary is sounds." MusicGen and AudioLM inherit almost the entire autoregressive machinery from text LLMs.

**Images are spatial, not sequential.** Pixels in an image don't have a natural order. You *could* try to generate them left-to-right, top-to-bottom (and models like Parti did exactly this), but it's a deeply unnatural imposition — the model has to decide what colour the top-left pixel is before it has any idea what the rest of the image will look like. Diffusion sidesteps the problem entirely by refining all the pixels together: coherence across the image emerges from the fact that every pixel participates in every refinement step, so every part of the image is informed by every other part as the image comes into focus.

**Video is spatial *and* temporal, but autoregressive was even worse.** A video has spatial structure like an image and temporal structure like audio. In principle you could go autoregressive over video tokens, but the combinatorics are brutal — a 5-second clip at 24 fps would be hundreds of thousands of tokens, and every new token has to look at all the previous ones. Diffusion over a block of numbers shaped like a stack of frames is computationally astronomical too, but it's embarrassingly parallel — every pixel of every frame is refined at the same time at every step, which is exactly what a GPU is built for. Everyone building production video models is doing some flavour of diffusion.

**Speech is the messy middle.** Speech synthesis pulls in three directions at once: low latency (you want to stream audio as it generates, not wait five seconds for a sentence), high quality (unnatural prosody is immediately noticeable), and expressive control (voice, emotion, speed). These push toward different architectures. Real-time production TTS (VITS, FastSpeech 2, most of what you'd find in a phone or a voice assistant) tends to be non-autoregressive and parallel — compute the whole waveform in one shot, sacrificing some expressive nuance for latency. Expressive voice-cloning systems (Bark, Tortoise) tend to go autoregressive for quality, sacrificing latency. Diffusion TTS is a smaller third camp. There's no single winner, and the engineering trade-offs matter.

![Two-column taxonomy of generative model families. On the left, autoregressive models: text (GPT, Claude, Gemini, Llama), music (MusicGen, AudioLM, Jukebox), some speech (Bark, Tortoise), older image models (DALL-E 1, Parti). On the right, iterative refinement models: images (Stable Diffusion, SDXL, Flux, Midjourney, Imagen, DALL-E 3), video (SORA, Veo, Runway Gen-3, Kling), some speech (StyleTTS 2).](/images/blog/generative-inference-taxonomy.svg)

## Where the Lines Blur

A few places where the clean autoregressive-vs-diffusion taxonomy gets messy in interesting ways.

**Diffusion Transformers (DiT).** The neural network doing the denoising inside a diffusion model used to be a particular kind of convolutional network called a UNet. Newer diffusion models — SORA, Flux, SD3, and most recent image and video models — have replaced that UNet with a transformer, the same family of architecture that powers LLMs. These models have self-attention layers. They *do* compute Q, K, V vectors and do dot products between them. What they *don't* have is a KV cache — the attention is over the entire block of numbers at every step, and that block doesn't grow from one step to the next. You can have attention without autoregressive generation, and Diffusion Transformers are the proof. Every step re-runs the whole attention computation from scratch over the same-size block.

**Autoregressive image and video models still exist.** Parti, VideoPoet, and a handful of newer entries are autoregressive over image or video tokens. They're typically less efficient than diffusion for the same compute budget, but they retain some nice properties — you can stream tokens, you can do prompt caching, and the generation loop is exactly the LLM loop. If you ever come across "streaming image generation," it's probably one of these.

**Hybrid pipelines are the norm, not the exception.** Almost every production generative AI product chains models from both families together. An image generation request flows through an autoregressive LLM that interprets the prompt, an iterative-refinement diffusion model that generates the image, and sometimes another autoregressive model that captions or refines the result. Your infrastructure has to handle both profiles in the same pipeline, with completely different batching, retry, and scaling strategies for each.

**Flow matching is diffusion's close cousin.** Rectified flow, consistency models, flow matching — these are all different mathematical framings of the "start with noise, refine iteratively" idea. Operationally they live in the iterative-refinement family, even when the underlying maths diverges from classical diffusion. Stable Diffusion 3 uses rectified flow under the hood; from the outside you'd never know.

## The Bottom Line

"It runs on a GPU" is almost useless as a mental model for any of this. Two models running on the same H100, in the same datacentre, drawing the same power, can have wildly different operational profiles — different latency shapes, different retry semantics, different cost structures, different scheduling strategies — depending on whether they're autoregressive or iterative refinement. Knowing the family a model belongs to tells you, without reading any documentation, roughly how it will behave under load and what operational problems you'll hit first.

The next time you're staring at a generative AI product and trying to reason about its behaviour, the first question isn't *"what's the model?"* It's *"is the state a growing sequence or a fixed-size latent being refined?"* Everything else downstream falls out of that one answer.

And if you've been following the LLM-focused posts in this series and thinking *"OK I get how LLMs work, does this all transfer?"* — the honest answer is: half of it. The autoregressive half. The iterative refinement half is a genuinely different shape of computation that happens to share a GPU and a few words of vocabulary with the autoregressive half. Treat it as a different system, and you'll be much less surprised by what it does.
