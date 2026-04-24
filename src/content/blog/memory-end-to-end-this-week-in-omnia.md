---
title: "Memory, End-to-End: This Week in Omnia"
description: "Everyone on Reddit and X is shipping agentic memory this month. We've had basic memory in Omnia for a while; this week we cranked it up a bit more. Here's what landed between 2026-04-18 and 2026-04-24 — MemoryRetentionPolicy as a CRD, consent-revocation cascade, purpose-filtered retrieval, trust-aware redaction, summarisation-as-an-agent — and the facade auth chain that landed the same week, which is really the other half of the same story."
date: 2026-04-24
tags: ["omnia", "promptkit", "status-update", "memory", "retention", "auth", "kubernetes"]
author: "Charlie Holland"
image: /images/blog/memory-skynet-splash.svg
draft: false
---

## Everyone's Building Memory

Hang about on Reddit or X for five minutes and you'll notice: everyone is building agentic memory. Every other post is a new vector store, a new graph over a vector store, a new framework wrapping a vector store, a new "Redis for agents."

If you're feeling paranoid you could read that as the agents themselves steering their human controllers toward the next necessary component in their evolution — another quiet step down the road to Skynet. More pragmatically, it's a clear gap and there are a lot of ways to fill it.

We've had basic memory in Omnia for a while. This week we cranked it up a bit more. The point of this post isn't to add one more "we built agent memory" claim to the pile — it's to call out three questions the vector-store posts mostly skip:

- Can a user revoke consent to a category of data and have every row that reflects that consent disappear on the next retention tick, audit-logged?
- Can a "billing" agent be structurally prevented from seeing memories written under "support"?
- Can the memory a user explicitly asked you to persist keep the email address they wrote down, while a memory that's merely inferred gets its PII scrubbed?

Most systems say no to all three. This week Omnia said yes to all three. Alongside it, the **facade auth chain** landed on the same surface — four pluggable validators behind a single middleware, strict by default — which is really the other half of the same story: agents now have a *trust model that survives production*.

[Last Friday](/blog/skills-end-to-end-this-week-in-omnia-and-promptkit) was the skills half of the stack — declare, mount, load, serve. This is the dynamic counterpart.

Here's what actually merged, and why any of it matters.

## The CRD

**`MemoryRetentionPolicy` as a first-class Kubernetes resource ([#999](https://github.com/AltairaLabs/Omnia/pull/999)).** The plan had been sitting in the backlog for three weeks. This week the first phase landed: cluster-scoped CRD, validating controller, per-tier config for `institutional` / `agent` / `user`, five modes (`Manual` / `TTL` / `Decay` / `LRU` / `Composite`), per-category overrides. Nothing applies the policy yet in this phase — the validation has to be right before the worker is allowed anywhere near real rows. Phase 1 also watches `Workspace` so a policy that previously failed `WorkspacesResolved` re-reconciles the moment the workspace lands, instead of staying permanently stuck.

Over the next four days the phases filled in behind it:

- **Phase 2 — `accessed_at` on the read path ([#998](https://github.com/AltairaLabs/Omnia/pull/998)).** The `memory_observations.accessed_at` and `access_count` columns had existed since the initial schema but nothing wrote to them. That meant the multi-tier ranking formula's recency term was dead weight and any future LRU pruning had no signal to work with. Fire-and-forget goroutine per retrieval, detached from the caller's context so a cancelled request doesn't kill the write, 5s bounded, Prometheus-instrumented. Now every row the retriever actually returned gets its LRU signal refreshed.
- **Phase 3 — composite retention worker ([#1000](https://github.com/AltairaLabs/Omnia/pull/1000)).** The worker that actually applies the policy. Weighted Composite mode combines recency, access count and age into a single score; LRU falls out of that. `perCategory` overrides so the compliance team can set a stricter TTL on `pii` without touching the rest.
- **Phase 4 — consent revocation cascade ([#1001](https://github.com/AltairaLabs/Omnia/pull/1001)).** More on this below — this is the one that matters.
- **Phase 5 — supersession cleanup ([#1002](https://github.com/AltairaLabs/Omnia/pull/1002)).** Hard-deletes observations that a summariser has already replaced, once `graceDays` have elapsed. Grace is measured from the summary's `created_at`, not the source's — operators get the same rollback window regardless of how far back the compacted data was.

Five phases, five PRs, one week. The model from last week held: ship the primitive before you ship the thing that uses it.

## The Hard Parts

Three things the naïve "put vectors in a DB" memory system skips. Omnia shipped all three this week.

![The memory trust model: three tiers on the left (institutional, agent/workspace, user/session), a MemoryRetentionPolicy tick in the middle applying TTL/Decay/LRU/Composite plus a consent-revocation cascade and a supersession branch, and a retrieval call on the right filtering by purposes, tier, workspace, with trust-aware redaction on the write path. The through-line: purpose, consent_category, and provenance travel with the row from write through retention to retrieval.](/images/blog/memory-trust-model.svg)

**Consent revocation cascade ([#1001](https://github.com/AltairaLabs/Omnia/pull/1001)).** When a user drops a category from `user_privacy_preferences.consent_grants`, rows tagged with that category need to disappear. The question is *how*. The naïve design is event-based: subscribe to consent changes, react to each event, hope nothing was missed. That design fails the moment the consumer crashes or the event bus drops a message, and it fails invisibly — the row stays, the user never knows.

The actual design is stateless. Each retention tick *joins* `memory_entities` against the current consent grants. Any user-tier row whose `consent_category` isn't in the current grant set is considered revoked — end of story. No event bus. No snapshot tracking. Missed revocations surface automatically on the next tick. Per-action dispatch gives operators the shape they need: `SoftDelete` flips `forgotten=true` and starts a grace-period clock, `HardDelete` does an immediate `DELETE ... FOR UPDATE SKIP LOCKED`, `Stop` is a no-op for the cascade itself while blocking future writes.

The design literature on machine unlearning — [Bourtoule et al., *Machine Unlearning*, IEEE S&P 2021](https://arxiv.org/abs/1912.03817) — is very clear that the hard part is *proving* something has been forgotten, not just deleting it. A stateless tick that runs on every pass and joins against current consent is the closest the classical data-retention pattern gets to that property. You don't need a proof of deletion if the architecture makes re-introducing a row impossible.

**Purpose-filtered retrieval ([#996](https://github.com/AltairaLabs/Omnia/pull/996)).** The `memory_entities.purpose` column had existed since the initial schema. Nothing read or wrote it from Go. This week `insertEntity` stamps purpose from `Metadata[MetaKeyPurpose]`, `MemoryService.SaveMemory` falls back to `Config.Purpose` when the caller doesn't set one, and `MultiTierRequest.Purposes []string` filters retrieval — single-element renders as `e.purpose = $N`, multi-element as `e.purpose = ANY($N)`, empty returns everything.

The point of this isn't labelling. The point is that a "billing" agent asking the memory store a question now *cannot see* observations written under "support." The filter happens in SQL, not in the agent prompt. This is the standard academic frame for purpose-based access control — [Byun et al., *Purpose Based Access Control of Complex Data for Privacy Protection*, SACMAT 2005](https://dl.acm.org/doi/10.1145/1063979.1063998) — applied to an agent-memory store. Agent frameworks almost universally skip it because their mental model is "memory is a helper, all memories are fair game." For an enterprise deployment that mental model is not tenable, and the week this landed is the week we stopped having to ask operators to trust a prompt.

**Trust-aware redaction ([#995](https://github.com/AltairaLabs/Omnia/pull/995)).** Every memory platform has a redactor. The useful question is whether the redactor knows the difference between *"my email is charlie@example.com"* (the user stated this explicitly; they want you to remember it) and *"the assistant inferred the user's email from a CC header"* (the user never agreed to this being stored). Most redactors don't. They either scrub everything (useless) or scrub nothing (dangerous).

The redactor now classifies its built-in patterns by category. *Structural* patterns — SSN, credit card, IP — are always scrubbed. *Personal* patterns — email, phone number — are kept when the row's `trust_model` is `Explicit`, i.e. provenance is `user_requested` or `operator_curated`. Anything else falls through to `TrustInferred` and gets the full PII sweep. Operator-defined custom rules are always structural.

This is the right split. [MemGPT (Packer et al., 2023)](https://arxiv.org/abs/2310.08560) and the [Generative Agents paper (Park et al., 2023)](https://arxiv.org/abs/2304.03442) both lean on the idea that memory quality is a function of *what the system decided to remember*, not just what it was told. The trust-model tag is that decision, made explicit, persisted, honoured at write time. The redactor is now the first thing that respects it.

## The Other Half of the Memory Story: Identity

The same week Omnia shipped the memory trust model, it shipped the identity trust model that makes the memory trust model enforceable. These two threads are the same story.

![The Omnia facade auth chain. An inbound request flows through auth.Middleware into a Chain of validators: sharedToken, apiKeys, OIDC, edgeTrust, and finally the management-plane validator. Each returns ErrNoCredential to fall through, an AuthenticatedIdentity to admit, or any other error to short-circuit reject. On admit, the identity carries Subject, Role, EndUser, Origin and Claims into policy.WithIdentity for downstream ToolPolicy CEL. If every validator returns ErrNoCredential the chain is strict by default and returns 401 — the default flip that closes C-3.](/images/blog/facade-auth-chain.svg)

A memory that says "purpose = billing, workspace = acme, user = alice" is a set of literal strings in a Postgres row. It becomes *a security boundary* only when the request asking for it is itself authenticated as Alice, working on Acme's workspace, with permission to see billing. Ship the memory model without the identity model and you've built a more convincing fiction.

So the facade auth chain landed the same week, in fifteen PRs. The shape (see diagram) is a first-admit-wins `Chain` of pluggable `Validator`s wrapped by a single `http.Handler` middleware:

- **`sharedToken` ([#952](https://github.com/AltairaLabs/Omnia/pull/952))** — constant-time Bearer compare against a Secret. `crypto/subtle.ConstantTimeCompare` so a timing-oracle attack can't leak token length; refuses to construct from an empty string so a missing Secret can't silently always-admit.
- **`apiKeys` ([#953](https://github.com/AltairaLabs/Omnia/pull/953))** — per-caller SHA-256 hashes loaded from labelled Secrets. 30s refresh cadence so rotation and revocation are live. Initial-load failures are fatal; refresh failures log and keep the previous snapshot.
- **`OIDC` ([#957](https://github.com/AltairaLabs/Omnia/pull/957) + [#959](https://github.com/AltairaLabs/Omnia/pull/959))** — RS256 JWT verified against a per-agent JWKS Secret that the AgentRuntime controller auto-fetches from the issuer's discovery endpoint every six hours ([cache fast-path in #976](https://github.com/AltairaLabs/Omnia/pull/976)). `WithValidMethods` pins RS256 so an HMAC-signed token can't accidentally verify against the RSA key material.
- **`edgeTrust` ([#954](https://github.com/AltairaLabs/Omnia/pull/954))** — trusts `x-user-id` / `x-user-roles` / `x-user-email` headers emitted by Istio's `RequestAuthentication` after JWT validation, with the absolutely-mandatory companion fix ([#968](https://github.com/AltairaLabs/Omnia/pull/968)) that installs a Lua `EnvoyFilter` on `SIDECAR_INBOUND` which strips any attacker-supplied copies *before* `jwt_authn` runs. Without that strip filter, any caller holding any valid JWT could set `x-user-id: admin@victim.com` themselves and the validator would admit them as `admin`. With it, only the verified-claim-derived headers are present by the time the facade reads them.
- **Management plane** — dashboard-minted JWT, per-admin pseudonymous subject derived from a hash of the iron-session cookie ([#972](https://github.com/AltairaLabs/Omnia/pull/972)) so audit logs can distinguish admin A from admin B without ever decrypting the cookie.

**Default flip ([#958](https://github.com/AltairaLabs/Omnia/pull/958), hardened in [#967](https://github.com/AltairaLabs/Omnia/pull/967)).** The critical change. A non-empty auth chain where every validator returns `ErrNoCredential` now returns `401` instead of proceeding unauth. This is the pen-test finding C-3 closed. `WithAllowUnauthenticated(true)` remains as a dev-mode escape hatch for empty chains; `OMNIA_FACADE_ALLOW_UNAUTHENTICATED` is the env-var version. Unparseable values fail closed.

**Tool policy integration ([#956](https://github.com/AltairaLabs/Omnia/pull/956)).** Once an identity is admitted, it rides into `policy.WithIdentity` on the context. `ToolPolicy` CEL rules now get an `identity` root — `identity.role == "admin" || identity.claims.department == "finance"` — so the same identity that authenticated the request is the identity that gates whether a given tool call is allowed. Memory purpose-filtering gates what the agent can *see*; ToolPolicy CEL gates what it can *do*. Same identity, two layers.

**Status condition ([#970](https://github.com/AltairaLabs/Omnia/pull/970)).** `kubectl describe agentruntime` now surfaces an `ExternalAuth` condition with one of three branches: `DashboardOnly`, `DataPlaneConfigured` (and it lists the admit paths — `"facade admits: sharedToken, oidc, managementPlane"`), or `Unreachable` for the foot-gun configuration of `allowManagementPlane=false` with zero data-plane validators. The foot-gun is now visible at reconcile time, not at 3am.

The through-line: **identity is now a resource in its own right, declared per-agent, verified by pluggable validators, and consumed by the same CEL engine that gates tool calls and the same redactor that decides what memory to keep**. Every other "agent platform" punts on this and tells you to put a gateway in front. We no longer do.

Worth noting for teams whose mental model of this is "just stick an OIDC proxy in front of it": the threat model includes prompt injection from the agent's upstream inputs. See [Greshake et al., *Not what you've signed up for*, 2023](https://arxiv.org/abs/2302.12173) — indirect prompt injection can talk *downstream* to your tools, so per-tool-call authorisation against a verified caller identity is exactly the property you need. Without it, any agent that can read untrusted content is a confused-deputy waiting to happen.

## Summarisation as an Agent

One small trick worth calling out separately. **`feat(memory): summarization via scheduled agent ([#997](https://github.com/AltairaLabs/Omnia/pull/997)).**

The obvious way to ship a memory-compaction LLM summariser is to build a new microservice. Instead we built two compaction HTTP endpoints on `memory-api` (`GET /api/v1/compaction/candidates`, `POST /api/v1/compaction/summaries`), shipped a ~180-LOC `cmd/a2a-invoker` that does a one-shot A2A `SendMessage` call and exits, and provided a reference `PromptPack + ToolRegistry + AgentRuntime + ServiceAccount + CronJob` bundle under `config/samples/omnia_v1alpha1_memory_summarizer.yaml`.

Operators deploy summarisation by applying a manifest. It's a scheduled agent. It uses the same provider plumbing as every other agent. Its prompt is tunable with the same tooling. It emits audit events tagged `scope=compaction` so you can tell summariser writes from user / operator writes on the dashboard. Zero new services. Zero new runtime concerns.

Every time you find yourself about to write a microservice for agent infrastructure, check whether the same thing can be a scheduled agent instead. Often it can.

Worth pairing this with the direction of the research on test-time memory — [*Titans: Learning to Memorize at Test Time*, Behrouz et al., 2025](https://arxiv.org/abs/2501.00663) and [*A-MEM: Agentic Memory for LLM Agents*, 2025](https://arxiv.org/abs/2502.12110) — which argue that the memory system itself should be adaptive and driven by the agent. A summariser that runs as a scheduled agent, prompted in YAML, is exactly the architectural hook you'd want for that class of research to plug in without changing the storage layer.

## The Rest of the Week

Two threads dominated but a lot else shipped.

**Dashboard security hardening.** Redis-backed OAuth session store ([#943](https://github.com/AltairaLabs/Omnia/pull/943)) so the server doesn't carry session state and a rolling restart doesn't log everyone out. RFC 9207 `iss` preservation through the OAuth callback ([#979](https://github.com/AltairaLabs/Omnia/pull/979)) to keep Mix-Up Attack mitigation intact. Dedicated dashboard ServiceAccount with agent-pod hardening ([#938](https://github.com/AltairaLabs/Omnia/pull/938)). Security headers + cookie-clear attributes ([#939](https://github.com/AltairaLabs/Omnia/pull/939)). Operator-namespace auto-allow in the workspace `NetworkPolicy` ([#940](https://github.com/AltairaLabs/Omnia/pull/940)). Mgmt-plane JWT minted per-request in the dashboard WS proxy ([#950](https://github.com/AltairaLabs/Omnia/pull/950), [#947](https://github.com/AltairaLabs/Omnia/pull/947)) so the facade sees which admin is poking it.

**Workspace knowledge UI ([#987](https://github.com/AltairaLabs/Omnia/pull/987), [#982](https://github.com/AltairaLabs/Omnia/pull/982), [#981](https://github.com/AltairaLabs/Omnia/pull/981)).** The UI half of institutional memory. `/workspaces/{name}/knowledge` gets a list + create + per-row delete page, and a bulk-import panel that parses either a JSON array or markdown `## Section` headers with per-entry failure isolation. Backed by a new server-side CRUD API with `provenance` forced to `operator_curated` and `trust_model` forced to `curated`; audit events tagged `scope=institutional` so dashboards can filter admin activity from user activity.

**Multi-mode retrieval ([#984](https://github.com/AltairaLabs/Omnia/pull/984)).** Beyond the standard tier-filtered SQL, `RetrieveMultiTier` now supports *structured lookup* (exact filter by kind + name-prefix + purpose — "load the API style guide") and *graph traversal* (BFS over `memory_relations` from seed entity IDs up to `MaxHops`, strictly workspace-scoped at every recursive step). Both modes feed into the same ranking pass as the tier rows, deduped by entity ID. The retriever now has three retrieval shapes — tier, structured, graph — under one API.

**PromptKit provider × platform matrix (#1009 closed out).** Five PRs to finish the matrix: claude-on-azure ([#1027](https://github.com/AltairaLabs/PromptKit/pull/1027)), claude-on-vertex ([#1024](https://github.com/AltairaLabs/PromptKit/pull/1024)), openai-on-bedrock ([#1026](https://github.com/AltairaLabs/PromptKit/pull/1026)), openai-on-azure hyperscaler routing fix ([#1023](https://github.com/AltairaLabs/PromptKit/pull/1023)), and rejection of unsupported provider×platform pairs ([#1025](https://github.com/AltairaLabs/PromptKit/pull/1025)) so you find out at config time, not mid-request, that a combination won't work.

**MCP HTTP+SSE transport ([#1030](https://github.com/AltairaLabs/PromptKit/pull/1030)) + MCPSource consumer wiring ([#1032](https://github.com/AltairaLabs/PromptKit/pull/1032)).** PromptKit now speaks MCP over HTTP with SSE as the streaming channel, and the MCPSource CRD from Omnia has a fully-wired consumer path on the PromptKit side. Preview of next week.

## What This Unlocks

A week ago, an agent could remember things but had no opinion about which things it was allowed to remember, for how long, under what identity, or on whose authority. Today:

- You declare a `MemoryRetentionPolicy` and the retention worker applies it on a tick, per tier, per category.
- A user revokes consent and the next tick removes every row tagged with that category — no event bus, no missed updates.
- A "billing" agent asking the retriever cannot see observations written under "support." The filter runs in SQL.
- The redactor respects the provenance tag: a user-requested memory keeps the user-stated email; an inferred memory gets the full PII sweep.
- The summariser is an agent. You deploy it with `kubectl apply`. It compacts memory on a cron.
- Every request to every agent surface is authenticated against one of four pluggable validators, backed by Secret-distributed material. Strict by default.
- The same verified identity that got you past the facade rides into the tool-policy CEL engine that decides which tools you can call.

None of those connections existed on the 18th.

## Next Friday

Next week's thread is `CodeGen-Sandbox` — a brand-new repo that went from empty to thirty PRs in 48 hours and is now the execution substrate our agents use to actually run code. AST-safe edits via tree-sitter, BM25 code search, LSP via gopls, snapshot restore, `last_test_failures` with structured Go failure parsing, coverage-aware test targeting, Prometheus metrics, OTel tool-call spans, agent-health metrics. It has its own story and it deserves its own post.

Status updates like this are a Friday thing.

## Further Reading

- *Machine Unlearning* — [Bourtoule et al., 2021](https://arxiv.org/abs/1912.03817)
- *Purpose Based Access Control of Complex Data for Privacy Protection* — [Byun, Bertino, Li, 2005](https://dl.acm.org/doi/10.1145/1063979.1063998)
- *MemGPT: Towards LLMs as Operating Systems* — [Packer et al., 2023](https://arxiv.org/abs/2310.08560)
- *Generative Agents: Interactive Simulacra of Human Behavior* — [Park et al., 2023](https://arxiv.org/abs/2304.03442)
- *Titans: Learning to Memorize at Test Time* — [Behrouz, Zhong, Mirrokni, 2025](https://arxiv.org/abs/2501.00663)
- *A-MEM: Agentic Memory for LLM Agents* — [2025](https://arxiv.org/abs/2502.12110)
- *Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection* — [Greshake et al., 2023](https://arxiv.org/abs/2302.12173)
- [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/)
