---
title: "The First Rule of Fine-Tuning Is: You Don't Need to Fine-Tune"
description: "Fine-tuning isn't a model upgrade — it's a way of baking whatever data you already have into the model's wiring, permanently, in a way you can't edit afterwards. Here's what's actually happening inside, why LoRA and QLoRA made it cheap without changing anything about inference, and why the teams that win at it are the ones who did the unglamorous data work first."
date: 2026-04-16
tags: ["llms", "fine-tuning", "training", "machine-learning", "infrastructure"]
author: "Charlie Holland"
draft: false
---

## The First Rule of Fine-Tuning Club

The first rule of fine-tuning club is: most people who join don't need to be here.

The second rule is: the people who do need to be here didn't need fine-tuning half as badly as they thought before they showed up.

I've had some version of this conversation maybe thirty times in the last year. A team building on an LLM is frustrated with how their product behaves — the model keeps going off-script, or failing on their specific flavour of input, or refusing to stick to a particular format — and they've arrived at the conclusion that *they need to fine-tune*. Sometimes they're right. More often, "we need to fine-tune" is the first clean-sounding idea they've had after a week of prompt-twiddling, and they've latched onto it because it sounds like the kind of thing a proper engineering team does when prompting stops working.

Then we sit down and look at what they actually have, and the conversation gets uncomfortable. Fine-tuning isn't a model upgrade. It's a way of taking whatever examples you currently have of the behaviour you want, and baking those examples into the model's wiring — permanently, in a way you can't edit afterwards. If your examples are sparse, or inconsistent, or full of mistakes you haven't noticed yet, fine-tuning doesn't fix that. It commits to it.

The short version, if you only read this paragraph: **fine-tuning doesn't give you a better model. It gives you the model your training data deserved.** If your data is weak, you can't fix that with a fancier training run. You can only bake the weakness in faster.

The rest of this post is the tour I end up giving those teams. What fine-tuning actually does to the model internals I walked through in [How Transformer Attention Actually Works](/blog/how-transformer-attention-works/) and [What Actually Happens When You Call an LLM API](/blog/what-actually-happens-when-you-call-an-llm/). Why the tricks that made fine-tuning accessible — LoRA and QLoRA — didn't change anything about how inference looks. And why the interesting engineering in any real fine-tuning project happens nowhere near the training script.

## What Fine-Tuning Actually Does to the Model

Every weight inside a transformer is a number the model learned during training. Lots of numbers, all of them small, sitting inside matrices that do the work of turning tokens into guesses about what token should come next. [The attention post](/blog/how-transformer-attention-works/) walked through the three most important of these — the `W_Q`, `W_K`, `W_V` matrices in every attention head, the ones that turn each token's embedding into the query, key and value vectors attention needs. The picture from that post was the fruit salad: the embedding is a bowl of mixed fruit, each weight matrix is a recipe, Q, K and V are three different smoothies you get when you blend the same salad three different ways.

Those three matrices aren't the only learned ones. There's also the embedding table — one big lookup that maps each token in the vocabulary to a few thousand numbers representing it. There are the feed-forward matrices between attention layers, which actually hold most of the model's numbers despite getting less attention in the press. There's an output projection at the end that turns the model's final internal state back into a score for every possible next token. Every single one of those was learned during training, by showing the model trillions of tokens of text and nudging every number very slightly, over and over, until the model got better at guessing what came next.

Fine-tuning is that same process, with two differences: you show it your examples instead of generic internet text, and you run it for a lot fewer steps. You hand the model a `(prompt, target_response)` pair, you run [the forward pass I described in the inference post](/blog/what-actually-happens-when-you-call-an-llm/) all the way to the end, and you look at what the model guessed for each token of the target. For each guess, you compute how wrong the guess was — a single number called the "loss," which is literally just *"you were this far off."* Then an algorithm works backwards through the same calculation, layer by layer, to figure out which direction to nudge every weight in every matrix to make the loss a little bit smaller next time. That backwards walk is called backpropagation, and the only reason I'm naming it is so you recognise the word when you see it somewhere else — you don't need to know how it works, only that it exists and that it's the thing that does the actual nudging.

Apply the nudges. Show the next example. Repeat, anywhere from thousands to millions of times.

The part that's weirdly hard to believe the first time you see it is that nothing about the *shape* of the model changes. Same number of layers. Same number of attention heads. Same vocabulary. Same everything. After a million training steps, the model looks identical from the outside. It still takes tokens in and produces guesses out. The only thing that's different is that the numbers inside all those matrices have been very slightly shifted. The recipes have been slightly tweaked. That's it. That's what fine-tuning is.

![A before-and-after view of the inside of a transformer. On the left, the base model: a token embedding table feeds into a stack of N identical layers, each containing an attention block with W_Q, W_K, W_V matrices and an output projection, followed by an MLP block with two more weight matrices. The stack feeds into a final output head that produces a score for every token in the vocabulary. On the right, the fine-tuned model: exactly the same shape — same layer count, same matrix sizes, same vocabulary — but every learnable matrix is marked with a small "Δ" badge indicating that its numbers have been nudged. A caption at the bottom reads: "Same layers. Same shape. Same forward pass. The only thing that changed is the numbers inside the boxes."](/images/blog/fine-tuning-what-changes.svg)

> Fine-tuning doesn't teach the model a new architecture or a new vocabulary. It moves the numbers inside the same matrices that were already there. "Learning," in this sense, is just "slowly reshaping the recipe."

This sounds almost too simple, which raises the obvious question: why was fine-tuning a project only well-funded labs could pull off until about two years ago?

## Why Nobody Used to Bother

Because nudging the numbers sounds cheap, and it isn't.

One word worth pinning down first, because it's about to come up a lot: *parameter*. It's the industry's name for one of those learned numbers I've been describing — one individual entry sitting inside one of the weight matrices. When you see a model's name with a number after it — Llama 3 70B, Mistral 7B, GPT-4 (rumoured to be north of a trillion) — that number is literally the count of parameters in the model, in billions. A "70B model" has seventy billion of those learned numbers in GPU memory, each one doing some small part of the work of turning an input into a guess about the next token. Nothing more exotic than that.

So: for a 70-billion-parameter model, "nudging every weight" means touching 70 billion numbers on every training step. You can't just touch them and move on, either — the algorithm that decides which way to nudge each weight works better when it remembers which way it was nudging the same weight a few steps ago, so it keeps a pile of bookkeeping numbers alongside the weights, roughly two to four times the size of the weights themselves. For a 70B model stored in half-precision (the standard these days — each number takes up 16 bits instead of 32), that's about 140 gigabytes of weights plus another 280 to 560 gigabytes of bookkeeping, all of which has to sit in the GPU's memory at the same time as the actual training data.

You can't do this on one GPU. You can't do it on four. You need eight top-end GPUs minimum and a carefully tuned distributed setup, and you need all of that just to do *one* training run — which, in my experience, is approximately never your last. Full fine-tuning used to be a project that burned tens of thousands of dollars in compute before you had any idea whether your data pipeline was even producing the behaviour you wanted.

That's the real reason most teams never fine-tuned. Not because the math was too hard — it's the same math as inference, run backwards — but because the memory bill was too big. Then something changed, and it changed in the place where the math turned out to be hiding the most slack.

## LoRA: The Trick That Changed Everything

The observation behind [LoRA](https://arxiv.org/abs/2106.09685) — Low-Rank Adaptation, from Microsoft in 2021 — is this: when you fine-tune a model on a specific task, the *useful* adjustment to any particular weight matrix turns out to be a surprisingly simple shape. Not small — it's still a full-sized matrix, same dimensions as the original — but simple in the sense that it can be built out of a much smaller number of moving parts than the original has. Mathematicians call this "low-rank." In plain English: the direction you actually want to nudge a big matrix lives on a thin, narrow sliver of all the directions you *could* nudge it, and you don't have to store the whole space to represent that sliver.

So here's the trick. Don't touch the original matrix at all. Freeze it. Leave every one of its numbers exactly as it was. Instead, store the adjustment *separately*, in a much smaller object — two skinny rectangles of numbers, usually called `A` and `B`, that, when you multiply them together, produce a full-sized matrix you can add to the original. At inference time, the model uses `W + BA` instead of just `W`. The original weights are never modified. The adjustment lives in those two small rectangles, and they're the only things you actually train.

Concretely: suppose the original weight matrix `W` is 4,096 × 4,096 — about 17 million numbers. A LoRA adjustment at "rank 16" (the typical setting) is two rectangles, one of shape 16 × 4,096 and one of shape 4,096 × 16 — together, about 130,000 numbers. A hundred times fewer things to train. Stacked across every layer of a 70B model, the LoRA adapter you save to disk at the end is often just tens of megabytes, next to the 140 gigabytes of frozen base weights it sits on top of.

![LoRA decomposition. On the left, a large filled square labelled "W · 4,096 × 4,096 · 17 million numbers · all trainable," showing what full fine-tuning has to work with. On the right, the LoRA version: the same large square, but now labelled "W · FROZEN," with a plus sign and two much smaller rectangles next to it labelled "B · 4,096 × 16" and "A · 16 × 4,096," their combined size annotated as "~130,000 numbers · trained." An arrow below points to a compact version of the forward-pass diagram from the inference post, with a note that every matrix multiply now uses (W + BA) and that the shape of the computation is unchanged. A caption at the bottom reads: "100× fewer numbers to train. Zero changes to what inference does."](/images/blog/lora-decomposition.svg)

And this is the part the mechanics make obvious, and the marketing almost always glosses over: **at inference time, nothing about the forward pass from [the previous post](/blog/what-actually-happens-when-you-call-an-llm/) is different.**

I mean this literally. The prefill pass still processes the prompt and builds the KV cache. The decode loop still emits one token per forward pass. The attention kernel still does its thing. The KV cache still lives in GPU memory, still tied to one specific card, still freed the instant the request ends. Every piece of operational weirdness I wrote about — continuous batching, prompt caching, all of it — still holds, because the thing the GPU is running still looks exactly the same.

The only difference is that when the model needs to multiply a token embedding by `W_Q` to produce a query vector, it now multiplies it by `W_Q + B_Q · A_Q`. You can either merge `BA` back into `W` once, at load time, and end up with one big matrix (same size as before, just with slightly different numbers in it), or you can keep them separate and do two small multiplications in sequence. Either way, the shape of the computation is unchanged. The K and V vectors that feed the KV cache are computed by the same kernel. The scheduler doesn't know anything has happened.

This is exactly why modern inference servers like vLLM and SGLang can hot-swap LoRA adapters in and out of a single running model without touching the serving path. One base model, many adapters, one GPU — that whole capability exists because LoRA left the inference shape alone.

> LoRA didn't make fine-tuning cheaper by changing what the model does. It made fine-tuning cheaper by shrinking what you have to *train*, while leaving the inference shape — every piece of it — exactly as it was.

## QLoRA: Squeezing the Base Model Too

[QLoRA](https://arxiv.org/abs/2305.14314) stacks a second trick on top of LoRA. The frozen base weights, which make up almost all of the memory cost, get compressed: instead of storing each weight as a 16-bit number, they're squeezed down to four bits each. Four bits is very little — only sixteen possible values per weight — but it turns out that with the right compression scheme, a model stored this way is nearly as capable as the original. (This is not obvious. There are papers about why it works at all. For our purposes: trust that it does.)

Four bits per weight instead of sixteen cuts the base model's memory footprint by a factor of four. A 70B model stored this way is about 35 gigabytes instead of 140, which suddenly fits on a single consumer-sized GPU, with room left over for everything else the training loop needs.

The LoRA rectangles themselves stay in higher precision during training, because the signal driving them is subtle and compressing them would lose too much of it. The base model gets *unpacked* on the fly — decompressed from 4-bit to a full-sized number just long enough to do the multiplication, then thrown away. Small runtime cost, huge memory savings.

As with LoRA, nothing about the shape of the computation at inference time changes. The base weights are still the same matrices, just stored more compactly. The attention math is the same math. The KV cache is still built the same way. From the serving path's point of view, a QLoRA-fine-tuned model looks indistinguishable from the base model it started with.

Together, LoRA and QLoRA turned fine-tuning a 70B model from "serious ML engineering project on a rented cluster" into "weekend thing on hardware you can buy off the shelf." That's genuinely the difference they made, and I want to be clear — access is a good thing, teams that needed this shouldn't have been priced out of it. But the bill used to do a lot of the thinking for you, and taking the bill away quietly removed one of the only things that forced teams to stop and ask whether they should. Which is why I find myself saying, almost daily now, the thing I end up saying about half the stuff tools and agents currently claim they can do for you: *just because you can doesn't mean you should.* If a training run cost twenty grand, someone on the team had to stop and ask whether it was worth twenty grand — and the act of asking would usually surface, within about five minutes, the fact that nobody could cleanly describe what the fine-tuned model was supposed to do that the base model couldn't. That check is gone now. Fine-tuning just slots into the roadmap. The *"wait, should we?"* conversation never happens. And then the awkward part shows up.

## Where It All Starts Leaning on Your Data

Here's the thing about the nudging process I described earlier. The only input the training loop has — the only piece of information in the whole system telling it which direction to move each weight — is the examples you gave it. The algorithm can't tell whether an example is correct. It can't notice that one example contradicts another. It can't tell the difference between a carefully-labelled demonstration of the behaviour you want and a stray document that happened to use similar words. It just nudges the weights in whatever direction each example asks for.

This is subtler than "garbage in, garbage out," though garbage in does still produce garbage out. It's that every example you put in *tugs on the weights* in some direction, and all the tugs get added up. Five thousand carefully-labelled examples teaching the model "respond in our company's support voice," plus two hundred examples that accidentally teach it to end every sentence with *"Thanks!"*, produces a model that mostly responds in your support voice and ends every sentence with *"Thanks!"*. You can't go back and edit the Thanks out. It's not in a prompt you can rewrite. It's in the weight matrices, smeared across millions of numbers, indistinguishable from all the other things those numbers are doing. The only way to remove it is to fine-tune the model *again* with a new set of examples that tug in the opposite direction — and hope the new tugs win out over the old ones.

Teams who are used to prompting don't have this intuition. In a prompt, a mistake in an example can be deleted and the next response fixes itself. In a fine-tune, a mistake in the training set is now a *fact about the model*.

> In a prompt, a mistake is something you can edit. In a fine-tune, a mistake is a fact about the model.

That single change in the relationship between your data and the model's behaviour is the real cost of fine-tuning, and it's the thing that never gets mentioned in the blog posts that walk you through running the training script. Everything people argue about — LoRA vs full fine-tune, rank 8 vs rank 16, DPO vs SFT, learning rate schedules — is tiny compared to *"what was on the left side of the arrow when we ran the training loop?"*

## Where the Real Engineering Actually Lives

A useful fine-tune needs a lot of examples. A small LoRA can shift things measurably on a few hundred good ones; a real behavioural change typically wants several thousand to tens of thousands; serious shifts (new personality, new domain vocabulary, a new refusal policy, a new output format enforced everywhere) want tens to hundreds of thousands of pairs. Nobody is hand-labelling hundreds of thousands of anything. So every serious fine-tuning project eventually runs into the problem of producing training data at scale — "datagen," in the shorthand I tend to use with clients — and this is where the engineering actually lives.

It's also where teams get blindsided, because datagen isn't a model problem. It's a data-curation problem, and most AI teams don't have a curation team.

The options, in rough order of popularity:

**Distillation from a bigger model.** You pick the most capable model you can get your hands on — a frontier-tier model from OpenAI, Anthropic, or Google — and you ask it to produce the outputs you want to train your smaller model on. It's the path of least resistance and it works more often than it has any right to. It has one hard limitation: the student learns whatever the teacher does, including the teacher's biases and, more awkwardly, the teacher's confidently-wrong answers. If the teacher hallucinates a particular flavour of policy text one time in fifty, your fine-tuned student inherits that hallucination as a *pattern*. You've compressed the teacher's behaviour — the good bits and the bad bits — into your student's weights, and the compression is one-way. You can't distil beyond the teacher.

**Self-generation.** The model generates its own training data, sometimes steered by a seed prompt or a topic list. This works for narrow expansions — teaching the model many variants of a format you already know it can do — and fails for broad ones, because the model pulls from its own built-in assumptions and those assumptions get baked in more deeply with each round. At worst, you hit something called "mode collapse," where the variety of examples the model generates shrinks with each pass until you're effectively training the model on a few dozen templates it wrote itself.

**LLM-as-judge labelling.** You've got examples — often mined from your real production logs — but you don't know which ones are good. So you ask another LLM to score them. This gives you a training signal at scale, but it also ties your training signal to your eval signal, and that connection hides exactly the failures you'd want an eval to catch. You can't evaluate a fine-tune using the same family of model that labelled the training data and expect the evaluation to mean anything. All you've done is train the student to be very good at fooling its sibling.

**Rule-based generation.** Templates, grammars, programmatic variations. This scales cleanly and stays honest about its limits — the data is exactly as smart as the rules, no smarter. For well-structured domains (code, SQL, form-filling, structured extraction) it's often underrated. For conversational or open-ended tasks it's a dead end.

Most real pipelines combine two or three of these: distil from a large model, filter the output with rules, then hand-label a small "gold set" that both seeds the process and keeps it honest. The interesting engineering is in the filters and the gold set, not in the prompt that drives the distillation.

The non-negotiable rule across every approach, and the one teams most often break because it's the most expensive, is this: **your eval set has to be real, even if your training set is entirely synthetic.** A real eval set means humans looked at each example, agreed it was the behaviour you actually wanted, agreed on the correct answer, and agreed on how to score a candidate response against it. It's slow. It's boring. It's the only thing standing between you and a fine-tuned model that looks great on an LLM-judged benchmark and falls apart the first time a real customer tries to use it.

![The fine-tuning data pipeline. On the left, four source boxes — "Distillation from a bigger model," "Self-generation," "LLM-as-judge labelling," and "Rule-based generation" — each feeding into a central "filter & curate" stage. From there, the flow goes through a small "gold seed set" anchor (annotated as human-labelled), then into a two-stage training pipeline: SFT first, then DPO, producing a fine-tuned model on the right. Off to the right of the whole pipeline, drawn as a physically separate locked box with a prominent border, sits the "Real Eval Set (human-curated)." A single arrow runs from the eval set TO the fine-tuned model, labelled "evaluated against"; no arrow runs the other way. A warning label on the locked box reads: "Never train on. Never LLM-judge against. Never contaminate." A caption at the bottom reads: "Your eval set has to be real, even if your training set is entirely synthetic."](/images/blog/fine-tuning-datagen-pipeline.svg)

Fine-tuning without a real eval set isn't engineering. It's vibes with gradients.

## SFT → DPO: Same Idea, Richer Signal

Most production fine-tuning pipelines today run in two phases. First, supervised fine-tuning (SFT) on `(prompt, good_response)` pairs — the exact thing I described above. Second, a preference-optimisation step on `(prompt, chosen_response, rejected_response)` triples. The most common method for that second step these days is [DPO](https://arxiv.org/abs/2305.18290) — Direct Preference Optimization — which has largely replaced the older RLHF pipeline for teams that don't need the full reinforcement-learning machinery.

The underlying mechanism is the same one I've been describing: run the model on the examples, compute a number saying how wrong the guess was, work backwards to nudge the weights. What's different is the *shape* of the "how wrong" calculation. In plain SFT, the model is rewarded for producing the chosen response. In DPO, the model is rewarded for producing the chosen response *and* simultaneously penalised for producing the rejected one, graded against a frozen copy of the original model used as a sanity-check reference. The signal is richer — you're telling the model not just what you want, but what you want *instead of what*, and the contrast is more informative than a single positive example on its own.

The catch is the same datagen catch from the previous section, in a new costume: **you now need pairs, not examples.** Not "here are five thousand good responses," but "here are five thousand pairs where each pair is the same prompt answered in a way we prefer *and* a way we don't, and the two responses differ on the *specific axis* we care about."

Generating those pairs is harder than generating examples. If you use an LLM to produce both the preferred and the rejected responses, you inherit its biases twice. If you generate the rejected responses by sampling from a weaker model, they're usually so obviously bad that the contrast teaches the model nothing it didn't already know — the signal collapses to "don't produce gibberish," which the base model already had down. Useful preference data lives in the narrow band where both responses are plausible and only one is what you actually wanted, and building that data is genuine engineering work, not a one-line script.

DPO isn't a magic upgrade over SFT. It's a richer training signal that demands a richer data pipeline. Teams that crack the data pipeline get a real lift from it. Teams that don't are just paying for a second training run.

## The Hidden Cost: What You Break on the Way

A model's weight matrices aren't filed by topic. When you reshape them to be better at "answering support tickets in our company voice," you unavoidably reshape them for everything else the model used to do. Push too hard on a narrow distribution of examples and the model gets worse at arithmetic, at code, at general knowledge, at step-by-step reasoning — the broad capabilities that made the base model worth starting from in the first place. ML people call this "catastrophic forgetting." It's real, and it'll bite you if you aren't watching for it.

LoRA mitigates it mechanically: because the base weights are frozen and the adjustment is bounded in how far it can move things, the damage to broad capabilities tends to be much smaller than with full fine-tuning. "Smaller" isn't "none." Any team shipping a fine-tuned model should be running broad-capability checks in addition to their own domain tests, because the failure you haven't checked for is the one that'll show up in front of a customer.

You fine-tuned the model to be better at support tickets. You didn't realise it also got worse at adding two numbers together in the middle of a ticket, until a customer asked it to calculate a refund.

## The Rules, Restated

The first rule of fine-tuning club is: most people who join don't need to be here. The second rule is: the ones who do need to be here are the ones who already did the data work. Everyone else is just paying the GPU bill to get a faithful compressed copy of whatever mess their training data had in it.

The math on the back end — the part of fine-tuning that sounds intimidating — is actually the easy part. It's the same math as inference, run backwards one layer at a time. LoRA and QLoRA changed what it *costs* to run that math, but they didn't change what the math does. What the math does is take the examples you give it and move the weight matrices in whatever direction those examples pull. The ceiling on what the weights can do at the end is set, hard, by the quality of what you fed in. No training trick fixes a weak data pipeline. No architectural upgrade turns bad examples into good weights. No clever loss function lets you skip the hard part.

The hard part is the datagen pipeline and the real eval set. The teams that win at fine-tuning are the teams that admit this early and staff against it. Every other team ends up shipping a model whose behaviour is a compressed shadow of their training data's flaws, and then spending the next quarter trying to work out why.

The other popular shortcut lands in the same trap from the opposite side. *"Skip fine-tuning, just use RAG"* sounds like a lighter lift, and [in practice it rarely is](/blog/rag-production-failure/) — RAG is a data problem too, dressed up as a retrieval problem. The failure mode is different (bad chunks instead of bad gradients), but the root cause is the same: whichever path you pick, the thing that actually decides whether your system works is the quality of the data and the rigour of the curation. No tool in the stack substitutes for doing that work.

So here's the thing I tell teams when they walk in asking for help fine-tuning a model. Fine-tuning isn't a way to avoid doing the data work. It's a way to *formally commit* to whatever data work you've already done. If you want the output to be good, the data has to be good before the training run starts. There is no pass of the algorithm that fixes it afterwards.

The gradients only know what you told them.
