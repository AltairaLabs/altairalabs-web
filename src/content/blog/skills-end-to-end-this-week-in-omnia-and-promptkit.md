---
title: "Skills, End-to-End: This Week in Omnia and PromptKit"
description: "For the last month 'Skills' meant slightly different things in each repo. This week both halves finally met — PromptKit shipped the primitives that make a skill safe to load, Omnia shipped the CRD, reconciler, runtime logging and dashboard that make declaring one a one-line change. Here's the status update: what shipped between 2026-04-11 and 2026-04-17, why it matters, and the PromptKit v1.4.5 release that dropped alongside it."
date: 2026-04-17
tags: ["omnia", "promptkit", "status-update", "skills", "kubernetes"]
author: "Charlie Holland"
draft: false
---

## The Week the Primitive Met the Cluster

For the last month we've had the word "Skills" in both repos and meant slightly different things by it. PromptKit had a `SkillSource` — a bundle of markdown instructions and resources that an agent could load on demand, à la Claude Code. Omnia had a `PromptPack` that *knew* what a skill was supposed to look like but couldn't actually mount one. If you wanted to run the thing in production, you were hand-wiring a path, hand-rolling RBAC, and praying the runtime logged enough for you to know what got loaded.

This week both halves met. PromptKit shipped the primitives that make a skill safe to load; Omnia shipped the Kubernetes-side machinery — CRD, reconciler, runtime logging, dashboard — that makes declaring one a one-line change. It's the first week you can stand up a `SkillSource` as a first-class resource and see it all the way through to the conversation that used it.

Here's what actually merged, and why any of it matters.

## PromptKit — The Primitives

Four changes in `SkillSource` land took a rough notion of "a bundle of files an agent can load" and turned it into something a production controller can trust:

**`MountAs` virtual path indirection for `SkillSource` ([#972](https://github.com/AltairaLabs/PromptKit/pull/972)).** A real skill lives somewhere specific in your build — `/skills/refund-flow/` — but the agent shouldn't care. `MountAs` decouples the on-disk layout from the namespace the agent sees. Same skill, served to different agents at different virtual paths, without copying or symlinks. This is the unblocker for sharing one `SkillSource` across multiple `AgentRuntime`s.

**Narrower `SkillSource` can upgrade the preload flag ([#970](https://github.com/AltairaLabs/PromptKit/pull/970)).** Skills overlap. When two `SkillSource`s match the same path and one is more specific, the narrower one now wins on `preload` semantics — a more-specific match can bump a skill from lazily-fetched to preloaded, but never silently demote one. It's a small rule, but the wrong answer either costs you latency or changes behaviour behind someone's back.

**`ReadResource` path-traversal coverage ([#986](https://github.com/AltairaLabs/PromptKit/pull/986)).** Skills load resources by name, and agents are a textbook untrusted-input source. The classifier was already there; this is the proof that `../../etc/passwd` and friends don't sneak through. Every new file-serving surface in an agent stack needs a test like this before it's production; we now have ours.

**Arena end-to-end wiring ([#955](https://github.com/AltairaLabs/PromptKit/pull/955), [#952](https://github.com/AltairaLabs/PromptKit/pull/952)).** Skills declared in an arena config now flow through discovery, filtering, and into preloaded prompt instructions. You can write an eval that exercises a specific skill without hand-constructing prompts.

The through-line: **every part of the skill lifecycle — resolve, mount, load, serve, test — now has a named, tested primitive**. That's the bar a downstream controller needs in order to ship it as a Kubernetes-native resource, which is exactly what Omnia did next.

## Omnia — The Control Plane

If PromptKit says *here's the primitive*, Omnia's job is to say *here's how you declare one in your cluster*. Seven PRs on Omnia's main got us there:

**`SkillSource` CRD + PromptPack wiring ([#809](https://github.com/AltairaLabs/Omnia/pull/809)).** The central change. `SkillSource` is now a first-class Kubernetes resource; a `PromptPack` references one by name and the skills resolve at bind time. You declare skills the same way you declare anything else in Omnia — `kubectl apply`, reconcile, done.

**Extracted `internal/sourcesync` from Arena controllers ([#808](https://github.com/AltairaLabs/Omnia/pull/808)).** The sync machinery started life inside the Arena controllers. `SkillSource` needed the same behaviour — fetch-from-source, cache, re-reconcile on change — so we pulled it out into its own package before duplicating. Same pattern the Istio VirtualService sync lives in. One controller-shaped thing, not three.

**Runtime logs loaded skills on startup ([#810](https://github.com/AltairaLabs/Omnia/pull/810)).** The runtime now emits a structured log line for every skill it successfully mounted, with the source, the virtual path, and the preload flag. When someone says "the agent didn't behave like the skill was loaded," you can check, not guess.

**Dashboard — read-only Skills pages + RBAC ([#830](https://github.com/AltairaLabs/Omnia/pull/830)).** List view, detail view, markdown preview, full RBAC integration. Read-only this week on purpose — we want the declarative path to be the primary one; the dashboard is for seeing what's already declared. Write-mode (the `SkillSource` explorer/dialog) is behind the same review process every other dashboard mutation goes through.

**`SkillSource` reconciler envtest coverage ([#815](https://github.com/AltairaLabs/Omnia/pull/815)) + runtime e2e ([#822](https://github.com/AltairaLabs/Omnia/pull/822), [#824](https://github.com/AltairaLabs/Omnia/pull/824)).** The reconciler has envtest coverage for the happy path, the missing-source path, and the re-sync-on-change path. The runtime has an e2e test that stands up a real container, verifies the manifest loads, and split-verifies the runtime log actually contains the skill. Belt and braces — because when Skills go wrong, they fail quiet.

The net effect: you can `kubectl apply` a `SkillSource`, watch it reconcile, see it show up in the dashboard with RBAC respected, and read the runtime log confirming the agent loaded it. None of those links existed on the 10th.

## The Rest of Omnia's Week

The Skills thread took most of the attention but wasn't the whole week. Three other fronts shipped meaningful work:

**Cloud-native chart knobs.** Gateway-API-native deployment knobs ([#838](https://github.com/AltairaLabs/Omnia/pull/838)) and `extraVolumes` / `extraVolumeMounts` / `extraEnv` injection hooks for CSI secret-stores and the like ([#843](https://github.com/AltairaLabs/Omnia/pull/843)). Between them, the chart now supports the deployment shape cloud-hosted customers have been asking for — Gateway API for ingress, CSI for secrets, no forking the chart.

**Session replay viewer ([#833](https://github.com/AltairaLabs/Omnia/pull/833)).** A session detail page that reconstructs the conversation: chat bubbles for the user-visible turns, a DevTools-style pull-out drawer for every tool call, LLM call, and internal event. Prev/next navigation between sessions. Think of it as *step debugger for an agent conversation* — you can see exactly what the agent saw, in the order it saw it. When a skill-powered agent does something weird, this is the surface you pull up.

**Runtime resilience.** Transport-specific retry policies on `ToolRegistry` ([#790](https://github.com/AltairaLabs/Omnia/pull/790)), retry execution for tool executors ([#791](https://github.com/AltairaLabs/Omnia/pull/791)), circuit breaker extended from LLM calls to HTTP / MCP / OpenAPI executors ([#793](https://github.com/AltairaLabs/Omnia/pull/793)), and provider-capability validation at `AgentRuntime` bind time ([#794](https://github.com/AltairaLabs/Omnia/pull/794)) so you find out at reconcile time, not mid-conversation, that your chosen model doesn't support the feature you asked for.

Also shipped, less visible but worth noting: reusable `SessionPrivacyPolicy` with per-request encryption primitives ([#801](https://github.com/AltairaLabs/Omnia/pull/801), breaking change), the release pipeline hardening (SBOM + provenance attestations, Trivy scan-only, every release image built on PR so the matrix doesn't silently break, [#847](https://github.com/AltairaLabs/Omnia/pull/847)), and a batch of OAuth middleware + cookie-overflow fixes in the dashboard ([#852](https://github.com/AltairaLabs/Omnia/pull/852)).

## PromptKit v1.4.5

Alongside the Skills work, PromptKit cut **v1.4.5** mid-week. Four headline changes:

- **Declarative embedding-provider config ([#984](https://github.com/AltairaLabs/PromptKit/pull/984))** and **declarative TTS + STT config ([#985](https://github.com/AltairaLabs/PromptKit/pull/985))**. Phases 1 and 2 of RFC #979. Stop hard-coding provider shapes in the runtime; declare them in YAML, get validation for free. Embeddings first because they were the gnarliest; TTS/STT because they were the most copy-pasted.
- **Azure OpenAI as a first-class platform** (ahead of v1.4.5, but part of this week's work). Not "OpenAI with a different endpoint" — a real platform with its own validator messages.
- **External `Selector` interface for per-turn tool narrowing ([#983](https://github.com/AltairaLabs/PromptKit/pull/983)).** You can now pin an exec-client selector that decides, per turn, which subset of tools an agent can see. Large tool registries without prompt-budget blowup.
- **Pluggable `Sandbox` interface for exec-backed hooks ([#976](https://github.com/AltairaLabs/PromptKit/pull/976), [#978](https://github.com/AltairaLabs/PromptKit/pull/978)).** Hooks that run shell-style commands now route through a `Sandbox` abstraction with `docker_run`, `docker_exec`, and `kubectl_exec` examples and YAML binding in `RuntimeConfig`. Run your hooks wherever makes sense — dev box, throwaway container, in-cluster pod — without forking the hook.

## What This Unlocks

A week ago, a Skill was a primitive you had to wire by hand. Today, you can declare one in YAML, watch Omnia reconcile it, see it in the dashboard with RBAC, read the runtime log confirming it loaded, and replay the conversation that used it. Meanwhile on the PromptKit side, the primitives that back all of that are type-safe, path-traversal-hardened, and covered by e2e tests.

Next week's thread: taking Skills from *declared* to *evaluated* — wiring `SkillSource` into Arena scenarios with seed memories and typed assertions so you can prove a skill-powered agent behaves under a canary before it sees a real user. The primitives for that landed in PromptKit this week ([#947](https://github.com/AltairaLabs/PromptKit/pull/947), [#949](https://github.com/AltairaLabs/PromptKit/pull/949)); the Omnia side — `SkillSource` referenced from an `ArenaSpec` — is next.

Status updates like this will become a regular Friday thing.
