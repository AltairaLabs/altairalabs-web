---
title: "Progressive Rollouts for AI Agents: Canary, Blue/Green, and Experiments in Six Phases"
description: "Two months ago we wrote about why prompt changes need canaries. This week we shipped the real thing — an Istio-backed, session-aware rollout system for AgentRuntime, built in six phases. Here's how it works and what we learned building it."
date: 2026-04-10
tags: ["kubernetes", "progressive-delivery", "agentops", "istio"]
author: "Charlie Holland"
draft: false
---

## The Problem

Pushing a new prompt, model, or provider config straight to 100% of your users is one of the scariest operations in AI agent ops. Prompt regressions [fail quietly](/blog/canary-deployments-for-ai-prompts/) — the agent still responds, it just responds worse. By the time your support queue tells you something is wrong, thousands of users have already had a bad conversation.

The fix, borrowed wholesale from [progressive delivery](https://martinfowler.com/bliki/CanaryRelease.html) on the code side, is to ship to a small slice of traffic first, measure, and promote only if the numbers hold. Argo Rollouts and Flagger do this well for stateless HTTP services. But AI agents have a few wrinkles that stock canary tooling doesn't address, and they're the reason we built `AgentRuntime.spec.rollout` instead of bolting on an existing tool.

This post is the deep dive on what we shipped: a six-phase implementation of canary, blue/green, and experiment rollouts for `AgentRuntime`, built on Istio, cohort-aware all the way through to OTel spans, and wired into a Prometheus-backed analysis step executor.

## Why AI Agent Rollouts Are Different

If you've shipped Argo Rollouts or Flagger before, a lot of this will look familiar. But AI agents have three wrinkles that stock canary tooling doesn't address:

**Non-deterministic failure modes.** Code either throws or it doesn't. A broken prompt produces grammatically valid, plausible-sounding output that happens to be wrong. HTTP 500 rate is not a useful rollback signal for an agent — you need eval scores, user satisfaction, tool-call correctness, refund rate, whatever actually measures quality in your domain.

**Stateful conversations.** A user halfway through a support conversation can't be re-routed from the stable variant to the canary on their next request. Mid-conversation flips break context. You need *sticky sessions* that persist across every WebSocket message and tool call in a session — not just load-balancer affinity.

**Multi-axis change surface.** A new version of an agent might be a new prompt, a new model, a different provider, a different tool registry, a tweaked system message, or all of the above. The rollout primitive has to cover all of them with the same semantics.

That last one is worth lingering on. In an earlier prerelease of Omnia, we attached rollout config to `PromptPack` directly — the idea being that a prompt change was the canonical thing you'd want to canary. It didn't take long to realise that was the wrong shape. A production agent swap is rarely *just* a prompt change; you want to roll out a new provider, a different model, an upgraded tool registry, or a combination of those. Scoping progressive delivery to prompts alone would have meant building the same machinery again the first time somebody wanted to canary a model swap. So we moved the rollout primitive up a level, onto `AgentRuntime` — the thing that actually knows about all the moving parts — and built it once.

## The Feature

One field: `AgentRuntime.spec.rollout`. No strategy enum — canary, blue/green, and experiments are all just different step sequences over the same primitive.

```yaml
apiVersion: omnia.altairalabs.ai/v1alpha1
kind: AgentRuntime
metadata:
  name: customer-support
spec:
  # ... normal runtime config ...
  rollout:
    candidate:
      promptPackVersion: "2.2.0"    # sparse overrides
    steps:
      - setWeight: 10
      - pause: { duration: 5m }
      - analysis: { templateName: eval-quality }
      - setWeight: 50
      - analysis: { templateName: eval-quality }
      - setWeight: 100
    stickySession:
      hashOn: x-user-id
    rollback:
      mode: automatic
    trafficRouting:
      istio:
        virtualService: { name: customer-support-vs, routes: [primary] }
        destinationRule: { name: customer-support-dr }
```

That's a canary rollout. A blue/green is the same primitive with different steps (`setWeight: 100` after `analysis` instead of a gradual ramp). An A/B experiment is the same primitive held at `setWeight: 50` indefinitely while cohort data accumulates. Three patterns, one schema.

The `candidate` block is a sparse override of the runtime spec. Change only the prompt pack version, or only the model, or only the tool registry. The rest of the spec is inherited from the stable variant.

## Implementation: Six Phases

We broke the work into six merged PRs, each with a green CI and a runnable integration test at the end. This matters — a 3,000-line "add rollouts" PR would have been unreviewable and would have almost certainly shipped with holes.

### Phase 1 — CRD schema ([#758](https://github.com/AltairaLabs/Omnia/pull/758))

The first PR was pure schema work. We added two new types:

- **`AgentRuntime.spec.rollout`** — the field shown above. Candidate overrides, step list, sticky session config, rollback config, and traffic routing pointers.
- **`RolloutAnalysis`** — a reusable EE CRD for metric templates. Prometheus, Arena eval, and HTTP providers. Parameterizable via `args` so the same template can be reused across runtimes.

No controller logic yet — just the types, validation, CRD generation, Helm chart sync, and the design spec checked in alongside the code. Getting the schema right first meant every subsequent phase had a stable contract to build against.

### Phase 2 — The controller and the dual-Deployment model ([#759](https://github.com/AltairaLabs/Omnia/pull/759))

This is where the real work started. The model is simple enough to explain in one paragraph: when a rollout is active, the AgentRuntime controller manages two Deployments — `{name}` (stable) and `{name}-canary` — with the candidate overrides applied to the second one. A Service selects both. An Istio DestinationRule separates them into `stable` and `canary` subsets via label selectors. The VirtualService splits traffic between subsets by weight.

The less obvious piece is making the step progression logic testable. We pulled it out into a pure function:

```go
// reconcileRolloutSteps evaluates the current step and returns a decision.
// It has no side effects — the caller applies them. This makes every
// transition independently unit-testable.
func reconcileRolloutSteps(
    runtime *v1alpha1.AgentRuntime,
    now time.Time,
) rolloutDecision {
    // ... evaluates setWeight / pause / analysis steps ...
}
```

Every step transition, pause expiration, and promotion decision is exercised by a unit test against a fake clock. The controller loop just applies whatever the pure function returns.

One genuinely embarrassing bug showed up in code review: our first pass had **overlapping Deployment selectors**. The stable Deployment selected `app=customer-support` and the candidate Deployment selected `app=customer-support,track=canary`. Because Kubernetes Deployments compare selector-matching pods against their own `replicas`, and because a candidate pod matched *both* selectors, the stable Deployment would see "too many pods" and start deleting the candidate's pods. This is the kind of bug that would only show up under real traffic, not under a unit test that mocks the pod list.

The fix was to make the selectors disjoint. Stable uses `track=stable`, candidate uses `track=canary`, and both labels are in the pod template *and* the Deployment selector. The Service omits `track` so it selects both. The DestinationRule subsets distinguish them for traffic splitting. Disjoint sets, no overlap, no pod thrashing.

Phase 2 also wired up the Prometheus metrics:

- `omnia_rollout_active` — gauge per runtime
- `omnia_rollout_step_transitions_total` — counter
- `omnia_rollout_promotions_total` / `omnia_rollout_rollbacks_total` — counters
- `omnia_rollout_step_duration_seconds` — histogram

And a new `RolloutActive` condition on `AgentRuntime.status`.

### Phase 3 — Istio VirtualService weight patching ([#760](https://github.com/AltairaLabs/Omnia/pull/760))

Phase 2 created the candidate Deployment, but it didn't actually move any traffic. Phase 3 is what makes `setWeight: 10` do something.

The interesting design choice here was **not importing Istio types into the core controller**. Istio is optional in Omnia — plenty of deployments run on bare Kubernetes with a simple Service and no mesh. We didn't want to drag `istio.io/api` into the core module just so the controller could patch a VirtualService.

The solution was the unstructured client. The controller talks to VirtualServices and DestinationRules as `unstructured.Unstructured` objects:

```go
vs := &unstructured.Unstructured{}
vs.SetGroupVersionKind(schema.GroupVersionKind{
    Group:   "networking.istio.io",
    Version: "v1",
    Kind:    "VirtualService",
})
if err := r.Get(ctx, nsName, vs); err != nil {
    if isNoMatchError(err) {
        // Istio CRDs not installed — graceful no-op
        log.V(1).Info("Istio not installed, skipping VirtualService patch")
        return nil
    }
    return err
}
// ... patch spec.http[i].route[j].weight via unstructured.SetNestedSlice ...
```

`isNoMatchError` catches the case where the cluster doesn't have Istio CRDs installed, logs at V(1), and returns nil. The rollout still runs — the weight just isn't enforced at the mesh layer. This means you can develop against a bare `kind` cluster, and you get progressive delivery as soon as you install Istio. No config flag, no separate build.

Phase 3 also added the first real rollback trigger: if the candidate Deployment has `UnavailableReplicas > 0 && ReadyReplicas == 0` and `rollback.mode: automatic`, the controller reverts the candidate, deletes the Deployment, and resets the VirtualService weights to 100% stable. This catches "the new prompt pack version doesn't exist" and "the new provider config is broken" without waiting for an analysis step.

### Phase 4 — Sticky sessions via DestinationRule ([#761](https://github.com/AltairaLabs/Omnia/pull/761))

Weight-based splitting isn't enough for conversational agents. If a user's first message lands on the canary and their second message lands on the stable variant, the context is gone.

Phase 4 patches the Istio DestinationRule to set a consistent hash:

```yaml
spec:
  trafficPolicy:
    loadBalancer:
      consistentHash:
        httpHeaderName: x-user-id
```

When `stickySession.hashOn: x-user-id` is configured, every request with the same `x-user-id` header hashes to the same variant for the duration of the rollout. The header itself can be anything — a JWT sub claim extracted by an Istio `RequestAuthentication`, a device ID, a session cookie. The controller doesn't care; it just patches the field.

On promotion or rollback, the consistent hash is removed. The same unstructured-client / graceful-no-op pattern as Phase 3.

With phases 2 through 4 in place, the cumulative architecture looks like this — one request hitting an Istio VirtualService that splits by weight, then a DestinationRule that hashes by user ID and routes to one of two Deployments distinguished by a `track` label:

![Dual-Deployment model: Istio VirtualService weights traffic between stable and canary subsets, DestinationRule pins each user to one subset via consistent hashing, and two Deployments with disjoint track labels back the stable and canary pods.](/images/blog/rollouts-dual-deployment.svg)

### Phase 5 — Cohort tracking end-to-end ([#762](https://github.com/AltairaLabs/Omnia/pull/762))

This was the longest phase to build and the most important one for experiments. Phase 4 gets the right user to the right variant. Phase 5 makes it possible to *analyze* which variant they ended up on.

The data flow:

![Cohort propagation: HTTP headers x-omnia-cohort-id and x-omnia-variant flow from the Istio ingress into the Facade on WebSocket upgrade, then into the Session API as CreateSessionRequest fields, and fan out to new Postgres columns and OTel span attributes.](/images/blog/rollouts-cohort-flow.svg)

The facade extracts `x-omnia-cohort-id` and `x-omnia-variant` from the WebSocket upgrade request, stores them on the `Connection` struct, and passes them into `CreateSessionOptions` when the session is created. The session API accepts new request fields, writes them to new Postgres columns (with partial indexes so queries by cohort stay fast), and echoes them back in responses. The OTel spans for every session operation get `omnia.cohort.id` and `omnia.variant` as attributes.

Twenty files across six layers — the API spec, the session model, Postgres migrations, the facade, the OTel pipeline, the policy package, and the generated HTTP client. The diff was +488/−15. Most of it is wiring.

The payoff is that every session in your database and every trace in your observability stack is now filterable by variant. That's the difference between "we ran a canary" and "we ran an experiment." A canary just needs weight splitting. An experiment needs post-hoc analysis, which means the data needs to be labeled at the source.

### Phase 6 — The analysis step executor ([#763](https://github.com/AltairaLabs/Omnia/pull/763))

The final phase is what makes rollouts autonomous. When a step is `analysis`, the controller fetches the referenced `RolloutAnalysis` template (via the unstructured client, because it's an EE CRD), merges the step's args over the template's defaults, substitutes `{{args.name}}` placeholders into the PromQL query, runs the query against Prometheus, and evaluates the success condition.

```yaml
apiVersion: omnia.altairalabs.ai/v1alpha1
kind: RolloutAnalysis
metadata:
  name: eval-quality-check
spec:
  args:
    - name: agent
    - name: threshold
      value: "0.9"
  metrics:
    - name: eval-quality
      interval: 5m
      count: 3
      failureLimit: 1
      successCondition: "result[0] >= {{args.threshold}}"
      provider:
        prometheus:
          address: http://prometheus:9090
          query: avg(omnia_eval_score{agent="{{args.agent}}", variant="canary"})
```

The step references the template by name and supplies the agent arg:

```yaml
rollout:
  steps:
    - setWeight: 20
    - analysis:
        templateName: eval-quality-check
        args:
          - name: agent
            value: customer-support
    - setWeight: 100
```

Pass → advance to the next step. Fail + automatic mode → roll back. Fail + manual mode → pause with a status message and wait for a human.

![Analysis step executor flow: the rollout step fetches the RolloutAnalysis template, merges args and substitutes placeholders, queries Prometheus, evaluates the success condition, and branches into three outcomes — pass advances, fail in automatic mode rolls back, fail in manual mode pauses for human review.](/images/blog/rollouts-analysis-flow.svg)

The condition evaluator supports `>=`, `<=`, `>`, `<`, and `==` against numeric PromQL results. That's intentionally minimal. If you want fancier logic, the right place to put it is inside the PromQL query, not inside a custom expression language that we'd have to maintain forever.

The Prometheus provider is the first of several — Arena eval is next — and `RolloutAnalysis` templates are reusable across runtimes. Define `eval-quality-check` once, reference it from every agent that wants the same quality gate.

## Design Choices Worth Calling Out

A few things that ended up mattering more than we expected:

**Steps, not strategies.** We started with a draft that had `strategy: Canary | BlueGreen | Experiment` and separate fields per strategy. We threw it out. Three named strategies with overlapping fields is worse than one composable step list that expresses all three. Users don't think in strategies; they think in sequences. "Start at 10%, wait 5 minutes, check quality, go to 50%, check again, promote." That's a sequence, not a strategy.

**Unstructured clients at every boundary.** The core controller imports zero Istio types and zero EE types. VirtualServices, DestinationRules, and RolloutAnalysis templates are all accessed through `unstructured.Unstructured`. This keeps the OSS core clean, lets us run on bare Kubernetes, and makes the EE boundary a matter of *what CRDs are installed*, not *what code is compiled in*. It costs us some type safety at the call sites, but the call sites are narrow and well-tested.

**Graceful degradation over feature flags.** There's no `--istio-enabled` flag. The controller probes for Istio CRDs at runtime and degrades to no-op if they're missing. Same for EE templates. This is more work than a flag, but it means the same binary runs on a developer's laptop, a bare production cluster, and a full mesh-enabled EE cluster, with the feature set scaling to whatever the environment supports.

**Pure functions for decisions, effects at the edges.** `reconcileRolloutSteps` returns a decision. `runAnalysis` returns a result. The controller loop applies effects. Every decision is independently unit-testable against a fake clock. This is obvious in hindsight and was not obvious in the first draft.

## What's Next

Six phases shipped. A few things left on the list:

- **Arena eval as an analysis provider.** Prometheus is a fine start, but the dream is plugging an Arena eval run in as a rollout gate. We already have Arena; wiring it in as an `AnalysisProvider` is a natural next step.
- **Dashboard visualization.** In-flight rollouts, step progress, traffic weights, and analysis results deserve a first-class UI. Right now you watch them via `kubectl` and Grafana.
- **More rollback triggers.** Pod failure is the obvious one. SLO burn-rate alerts, error budget exhaustion, and `AgentPolicy.OnFailure` propagation are all reasonable candidates.

## The Takeaway

Progressive delivery for AI agents is now a first-class primitive in Omnia. Same semantics as Argo Rollouts and Flagger, purpose-built for agent workloads, with session-aware sticky routing, cohort-based experiment analysis, and end-to-end observability through OTel. Canary, blue/green, and experiments all fall out of the same step-based schema. Istio is optional; the feature degrades gracefully without it.

If you're running AI agents in production and you're still pushing prompt, model, or provider changes directly to 100% of traffic, you shouldn't be. The patterns that made code releases safer work just as well for agents — they just needed a runtime that knows about sessions, cohorts, and multi-axis change.

The code is open source at [AltairaLabs/Omnia](https://github.com/AltairaLabs/Omnia) — the six PRs are [#758](https://github.com/AltairaLabs/Omnia/pull/758) through [#763](https://github.com/AltairaLabs/Omnia/pull/763). Full walkthrough in the [Progressive Rollouts tutorial](https://omnia.altairalabs.ai/tutorials/progressive-rollouts/).
